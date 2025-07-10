import type { V8LogProfile, V8LogScript, V8LogScripts } from './types.js';
import type { V8CpuProfileFunction } from '../../types.js';
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

export function parseJsName(name: string, scriptUrl: string | null = null): ParseJsNameResult {
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

export function processFunctions(
    v8logFunctions: V8LogProfile['functions'],
    v8logCodes: V8LogProfile['code'],
    v8logScripts: V8LogScripts
) {
    const missedScriptsByUrl = new Map<string, V8LogScript>();
    const getScriptByUrl = (scriptUrl: string, scriptId: number | undefined) => {
        if (!scriptUrl || typeof scriptId !== 'number' || scriptId === 0) {
            return null;
        }

        let script = missedScriptsByUrl.get(scriptUrl);

        if (script === undefined) {
            const id = scriptId;

            if (scripts[id]) {
                script = scripts[id];
            } else {
                script = {
                    id,
                    url: scriptUrl,
                    source: ''
                };

                if (scripts.length <= id) {
                    scripts.push(...Array.from({ length: id - scripts.length + 1 }, () => null));
                }

                scripts[id] = script;
            }


            missedScriptsByUrl.set(scriptUrl, script);
        }

        return script;
    };

    const scripts = v8logScripts.slice(); // make a copy to prevent input array mutation
    const scriptFunctionIndexByScript = new Map<V8LogScript | null, number>();
    const functions: V8CpuProfileFunction[] = [];
    const functionIndexMap = new Uint32Array(v8logFunctions.length);

    for (let i = 0; i < v8logFunctions.length; i++) {
        const fn = v8logFunctions[i];
        const source = v8logCodes[fn.codes[0]].source; // all the function codes have the same reference to script source
        const v8logScript = (source && v8logScripts[source.script]) ?? null;
        const { functionName, scriptUrl, line, column } = parseJsName(fn.name, v8logScript?.url);

        // wasm functions and some other has no source/script;
        // create a script by scriptUrl in that case
        const script = v8logScript || getScriptByUrl(scriptUrl, source?.script);

        // V8 creates two functions for a script: one with no source parsed (likely a preparse state),
        // and a second with the source parsed (regular Ignition codes).
        // It's unclear why there are two functions instead of a single one with two codes (further research needed),
        // possibly due to initial design choices. However, from a user perspective, there is no need to differentiate
        // these functions and codes, so CPUpro combines them.
        // TODO: Merge more functions, as it is typical for long-running scripts that V8 flushes functions (codes)
        // not called for a while (across several GC cycles), and recreates them once they are called again.
        const isScriptFunction = line === 0 && column === 0;
        const scriptFunctionIndex = isScriptFunction ? scriptFunctionIndexByScript.get(script) || -1 : -1;
        let functionIndex = scriptFunctionIndex;

        if (scriptFunctionIndex === -1) {
            functionIndex = functions.push({
                scriptId: script?.id || 0,
                name: functionName,
                start: source?.start ?? -1,
                end: source?.end ?? -1,
                line,
                column
            }) - 1;

            if (isScriptFunction) {
                scriptFunctionIndexByScript.set(script, functionIndex);
            }
        }

        functionIndexMap[i] = functionIndex;
    }

    return {
        scripts: processScripts(scripts),
        functions,
        functionIndexMap
    };
}
