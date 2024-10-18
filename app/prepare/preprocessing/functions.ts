import type { IScriptMapper, V8CpuProfileFunction } from '../types.js';
import type { Dictionary } from '../dictionary.js';

export function mapFunctions(
    dict: Dictionary,
    scriptMapper: IScriptMapper,
    functions?: V8CpuProfileFunction[] | null
) {
    const functionCallFrames = new Uint32Array(functions?.length || 0);

    if (Array.isArray(functions)) {
        for (let i = 0; i < functions.length; i++) {
            const { scriptId, name, start, end, line, column } = functions[i];

            functionCallFrames[i] = dict.resolveCallFrameIndex({
                scriptId,
                url: '',
                functionName: name,
                lineNumber: line,
                columnNumber: column,
                start,
                end
            }, scriptMapper);
        }
    }

    return functionCallFrames;
}

export function locFromLineColumn(line: number, column: number) {
    return line !== -1 && column !== -1
        ? `:${line}:${column}`
        : null;
}
