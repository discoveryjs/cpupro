import type { CpuProScript, CpuProScriptFunction, V8CpuProfileFunction } from '../types.js';

export function locFromLineColumn(line: number, column: number) {
    return line !== -1 && column !== -1
        ? `:${line}:${column}`
        : null;
}

export function processFunctions(
    inputFunctions: V8CpuProfileFunction[] = [],
    scriptById: Map<number, CpuProScript>
) {
    const scriptFunctions: CpuProScriptFunction[] = [];

    // process script's functions
    for (const inputFn of inputFunctions || []) {
        const script = scriptById.get(inputFn.scriptId) || null;
        const fn: CpuProScriptFunction = {
            id: scriptFunctions.length + 1,
            name: inputFn.name,
            script,
            start: inputFn.start,
            end: inputFn.end,
            line: inputFn.line,
            column: inputFn.column,
            loc: locFromLineColumn(inputFn.line, inputFn.column)
        };

        scriptFunctions.push(fn);

        // attach function to a script
        if (script !== null) {
            if (fn.start === 0 && fn.end === script.source.length) {
                script.compilation = fn;
            } else {
                script.functions.push(fn);
            }
        }
    }

    return {
        scriptFunctions
    };
}
