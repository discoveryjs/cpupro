import type { V8LogCode, V8LogFunction, V8LogScript, V8LogScripts } from './types.js';
import type {
    V8CpuProfileScriptFunction,
    V8CpuProfileScriptFunctionState,
    V8FunctionStateTier
} from '../../types.js';

export type ParseJsNameResult = {
    functionName: string;
    scriptUrl: string;
    line: number;
    column: number;
}

function parseLoc(url: string) {
    const locMatch = url.match(/\:(\d+)\:(\d+)$/);
    const loc = locMatch ? locMatch[0] : null;
    // V8 log locations are 1-based, but CPU profiles are zero-based.
    // Therefore, convert line and column to zero-based for consistency.
    // In some rare cases, V8 uses 0-based lines for specific locations, typically the first line,
    // so retain 0 for such lines
    const line = locMatch !== null ? (locMatch[1] === '0' ? 0 : Number(locMatch[1]) - 1) : -1;
    const column = locMatch !== null ? Number(locMatch[2]) - 1 : -1;

    return { loc, line, column };
}

// A function name could contain surrounding whitespaces
function cleanupFunctionName(name: string) {
    return name.trim();
}

export function parseJsName(name: string, script: V8LogScript | null = null): ParseJsNameResult {
    let scriptUrl = script?.url || null;

    if (name.startsWith('wasm-function')) {
        scriptUrl = 'wasm://wasm/' + name;
        name += ' ' + scriptUrl;
    }

    if (scriptUrl === '' || scriptUrl === '<unknown>') {
        const { loc, line, column } = parseLoc(name);

        return {
            functionName: cleanupFunctionName(loc !== null ? name.slice(0, -loc.length) : name),
            scriptUrl: '',
            line,
            column
        };
    }

    // robust way since name and url could contain white spaces
    if (scriptUrl !== null) {
        const [prefix, loc = ''] = name.split(scriptUrl);
        const { line, column } = parseLoc(loc);

        return {
            functionName: cleanupFunctionName(prefix),
            scriptUrl,
            line,
            column
        };
    }

    // fallback when no script
    const nameMatch = name.match(/^((?:get |set )?[#.<>\[\]_$a-zA-Z\xA0-\uFFFF][#.<>\[\]\-_$a-zA-Z0-9\xA0-\uFFFF]*) /);
    const functionName = nameMatch !== null ? nameMatch[1] : '';
    const url = nameMatch !== null
        ? name.slice(nameMatch[0].length)
        : name[0] === ' ' ? name.slice(1) : name;
    const { loc, line, column } = parseLoc(url);

    return {
        functionName,
        scriptUrl: loc !== null ? url.slice(0, -loc.length) : url,
        line,
        column
    };
}

export function functionTier(kind: V8LogCode['kind']): V8FunctionStateTier {
    switch (kind) {
        case 'Builtin':
        case 'Ignition':
        case 'Unopt':
            return 'Ignition';

        case 'Baseline':
        case 'Sparkplug':
            return 'Sparkplug';

        case 'Maglev':
            return 'Maglev';

        case 'Turboprop':
            return 'Turboprop';

        case 'Opt':
        case 'Turbofan':
            return 'Turbofan';

        default:
            return 'Unknown';
    }
}

export function processFunctionCodes(codeIndices: number[], v8logCodes: V8LogCode[]): V8CpuProfileScriptFunctionState[] {
    return codeIndices.map(codeIndex => {
        const code = v8logCodes[codeIndex];
        const codeSource = code.source || null;

        return {
            tm: code.tm || 0,
            tier: functionTier(code.kind),
            positions: codeSource?.positions || '',
            inlined: codeSource?.inlined || '',
            fns: codeSource?.fns || [],
            deopt: code.deopt
        };
    });
}

export function processScriptFunctions(
    functions: V8LogFunction[],
    codes: V8LogCode[],
    scripts: V8LogScripts
): V8CpuProfileScriptFunction[] {
    const scriptFunctions: V8CpuProfileScriptFunction[] = [];

    for (let i = 0, k = 0, prev: V8LogFunction | null = null; i < functions.length; i++) {
        const fn = functions[i];
        const source = codes[fn.codes[0]].source; // all the function codes have the same reference to script source
        const { functionName, line, column } = parseJsName(fn.name, source && scripts[source.script]);

        if (source === undefined) {
            // wasm functions and some other has no source;
            // temporary ignore such functions
            // console.log(fn, fn.codes.map(x => codes[x]));
            continue;
        }

        // V8 usually adds a first-pass parsing state of a module as a separate function, followed by a fully parsed state function;
        // in that case, merge script function entries into a single function with concatenated states
        if (prev !== null && prev.name === fn.name && line === 0 && column === 0) {
            scriptFunctions[k - 1].states.push(...processFunctionCodes(fn.codes, codes));
            continue;
        }

        scriptFunctions[k++] = {
            id: k,
            name: functionName,
            script: source.script,
            start: source.start,
            end: source.end,
            line,
            column,
            states: processFunctionCodes(fn.codes, codes)
        };

        prev = fn;
    }


    return scriptFunctions;
}
