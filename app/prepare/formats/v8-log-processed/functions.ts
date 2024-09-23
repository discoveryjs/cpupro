import type { V8LogCode, V8LogFunction, V8LogScript, V8LogScripts } from './types.js';
import type {
    V8CpuProfileScriptFunction,
    V8CpuProfileScriptFunctionState,
    V8FunctionStateTier
} from '../../types.js';
import { processScripts } from './scripts.js';

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

    // V8 preprocessor don't include an url to wasm function names
    if (name.startsWith('wasm-function') && !name.includes('wasm:')) {
        scriptUrl = 'wasm://wasm/unknown-script';
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
) {
    const missedScriptsByUrl = new Map<string, V8LogScript>();
    const getScriptByUrl = (scriptUrl: string) => {
        let script = missedScriptsByUrl.get(scriptUrl);

        if (script === undefined) {
            script = {
                id: processedScripts.length,
                url: scriptUrl,
                source: ''
            };

            processedScripts.push(script);
            missedScriptsByUrl.set(scriptUrl, script);
        }

        return script;
    };

    const processedScripts = processScripts(scripts);
    const processedScriptFunctions: V8CpuProfileScriptFunction[] = functions.map((fn, id) => {
        const source = codes[fn.codes[0]].source; // all the function codes have the same reference to script source
        const v8logScript = source && scripts[source.script];
        const { functionName, scriptUrl, line, column } = parseJsName(fn.name, v8logScript);

        // wasm functions and some other has no source/script;
        // create a script by scriptUrl in that case
        const script = v8logScript || getScriptByUrl(scriptUrl);

        return {
            id,
            name: functionName,
            script: script.id,
            start: source?.start ?? -1,
            end: source?.end ?? -1,
            line,
            column,
            states: processFunctionCodes(fn.codes, codes)
        };
    });

    return {
        scripts: processedScripts,
        scriptFunctions: processedScriptFunctions
    };
}
