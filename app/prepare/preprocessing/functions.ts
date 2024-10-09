import type { Dictionary } from '../dictionary.js';
import type { CpuProCallFrame, IScriptMapper, V8CpuProfileFunction } from '../types.js';

export function mapFunctions(
    dict: Dictionary,
    scriptMapper: IScriptMapper,
    functions?: V8CpuProfileFunction[] | null
) {
    const profileFunctions: CpuProCallFrame[] = [];

    if (Array.isArray(functions)) {
        for (const fn of functions) {
            const { scriptId, name, start, end, line, column } = fn;
            const callFrame = dict.resolveCallFrame({
                scriptId,
                url: '',
                functionName: name,
                lineNumber: line,
                columnNumber: column,
                start,
                end
            }, scriptMapper);

            profileFunctions.push(callFrame);
        }
    }

    return profileFunctions;
}

export function locFromLineColumn(line: number, column: number) {
    return line !== -1 && column !== -1
        ? `:${line}:${column}`
        : null;
}
