import { CpuProScript, CpuProScriptFunction, V8CpuProfileScript } from './types.js';

export const scriptFunctionsSorting = (a: CpuProScriptFunction, b: CpuProScriptFunction) =>
    (a.start - b.start) || (b.end - a.end) || (a.id - b.id);

export function processScripts(
    inputScripts: V8CpuProfileScript[] = []
) {
    const scripts: CpuProScript[] = [];
    const scriptById = new Map<number, CpuProScript>();

    // process scripts
    for (const { id, url, source } of inputScripts) {
        const script: CpuProScript = {
            id,
            url,
            source,
            module: null,
            compilation: null,
            functions: []
        };

        scripts.push(script);
        scriptById.set(script.id, script);
    }

    return {
        scripts,
        scriptById
    };
}

export function sortScriptFunctions(scripts: CpuProScript[]) {
    for (const script of scripts) {
        if (script.functions.length > 1) {
            script.functions.sort(scriptFunctionsSorting);
        }
    }
}
