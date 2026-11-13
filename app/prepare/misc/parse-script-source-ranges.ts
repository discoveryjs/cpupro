import { computeLineStarts, createLineBoundaries } from './line-boundaries.js';
import { functionRangeTypes, parseFunctionRanges, type ParsedFunctionRanges } from './parse-function-ranges.js';

export type FunctionRanges = {
    parsed: boolean;
    error?: string;
    ranges: FunctionRange[];
    starts: Uint32Array<ArrayBuffer>;
    indexes: Int32Array<ArrayBuffer>;
};
export type FunctionRange = {
    type: string;
    name: string;
    defaultConstructor: boolean;
    callFrameStart: number;
    callFrameStartLine: number;
    callFrameStartColumn: number;
    start: number; // with the leading comments
    startLine: number;
    startColumn: number;
    end: number;
    endLine: number;
    endColumn: number;
    selfSize: number;
}
// Function ranges of several scripts as columns, the ranges of a script follow the ranges of the previous one;
// a type is an index in a list of types
export type FunctionRangeColumns = {
    [Field in Exclude<keyof FunctionRange, 'type' | 'name' | 'defaultConstructor'>]: Uint32Array<ArrayBuffer>;
} & {
    type: Uint8Array<ArrayBuffer>;
    name: string[];
    defaultConstructor: Uint8Array<ArrayBuffer>;
};
const JSX_REGEX = /\.[mc]?[tj]sx($|[\?\#\|])/;
const TS_REGEX = /\.[mc]?ts($|[\?\#\|])/;

export function createFunctionRangeColumns(count: number): FunctionRangeColumns {
    return {
        type: new Uint8Array(count),
        name: new Array(count),
        defaultConstructor: new Uint8Array(count),
        start: new Uint32Array(count),
        startLine: new Uint32Array(count),
        startColumn: new Uint32Array(count),
        end: new Uint32Array(count),
        endLine: new Uint32Array(count),
        endColumn: new Uint32Array(count),
        callFrameStart: new Uint32Array(count),
        callFrameStartLine: new Uint32Array(count),
        callFrameStartColumn: new Uint32Array(count),
        selfSize: new Uint32Array(count)
    };
}

export function writeFunctionRanges(
    columns: FunctionRangeColumns,
    offset: number,
    ranges: FunctionRange[],
    types: Map<string, number>
) {
    for (let i = 0; i < ranges.length; i++) {
        const range = ranges[i];
        const index = offset + i;
        let type = types.get(range.type);

        if (type === undefined) {
            type = types.size;
            types.set(range.type, type);
        }

        columns.type[index] = type;
        columns.name[index] = range.name;
        columns.defaultConstructor[index] = range.defaultConstructor ? 1 : 0;
        columns.start[index] = range.start;
        columns.startLine[index] = range.startLine;
        columns.startColumn[index] = range.startColumn;
        columns.end[index] = range.end;
        columns.endLine[index] = range.endLine;
        columns.endColumn[index] = range.endColumn;
        columns.callFrameStart[index] = range.callFrameStart;
        columns.callFrameStartLine[index] = range.callFrameStartLine;
        columns.callFrameStartColumn[index] = range.callFrameStartColumn;
        columns.selfSize[index] = range.selfSize;
    }
}

export function readFunctionRanges(
    columns: FunctionRangeColumns,
    offset: number,
    count: number,
    types: string[]
): FunctionRange[] {
    const ranges: FunctionRange[] = new Array(count);

    for (let i = 0; i < count; i++) {
        const index = offset + i;

        // the property order of createFunctionRanges() keeps a single shape for all ranges
        ranges[i] = {
            type: types[columns.type[index]],
            name: columns.name[index],
            defaultConstructor: columns.defaultConstructor[index] === 1,
            callFrameStart: columns.callFrameStart[index],
            callFrameStartLine: columns.callFrameStartLine[index],
            callFrameStartColumn: columns.callFrameStartColumn[index],
            start: columns.start[index],
            startLine: columns.startLine[index],
            startColumn: columns.startColumn[index],
            end: columns.end[index],
            endLine: columns.endLine[index],
            endColumn: columns.endColumn[index],
            selfSize: columns.selfSize[index]
        };
    }

    return ranges;
}

function computeSelfSize(functionRanges: FunctionRanges): void {
    const { starts, indexes, ranges } = functionRanges;

    // The index ends with the end of the last top-level range, so its last entry always belongs to the script
    for (let i = 0; i < starts.length - 1; i++) {
        const rangeIndex = indexes[i];

        if (rangeIndex !== -1) {
            ranges[rangeIndex].selfSize += starts[i + 1] - starts[i];
        }
    }
}

// The script's line starts are given when they're computed anyway, e.g. in a parse worker
export function parseScriptSourceRanges(
    code: string,
    url?: string | null,
    fromWorker?: boolean,
    lineStarts: Uint32Array = computeLineStarts(code)
): FunctionRanges {
    if (!fromWorker) {
        console.warn('parseScriptSourceRanges should be called from a worker thread for performance reasons', { url, code });
    }

    const jsx = JSX_REGEX.test(url || '');
    const typescript = jsx || TS_REGEX.test(url || '');
    const functionRanges: FunctionRanges = {
        parsed: false,
        ranges: [],
        starts: new Uint32Array(),
        indexes: new Int32Array()
    };
    let parsed: ParsedFunctionRanges;

    try {
        parsed = parseFunctionRanges(code, typescript, jsx);
    } catch (error) {
        functionRanges.error = (error as Error).message;
        return functionRanges;
    }

    functionRanges.ranges = createFunctionRanges(parsed, createLineBoundaries(code, lineStarts))
        .sort((a, b) => a.callFrameStart - b.callFrameStart || b.end - a.end);

    // build index for faster search
    if (functionRanges.ranges.length > 0) {
        Object.assign(functionRanges, buildFunctionRangesIndex(functionRanges));
        computeSelfSize(functionRanges);
    }

    functionRanges.parsed = true;

    return functionRanges;
}

// Ranges of parsed functions with lines (1-based) and columns (0-based) of their call frame starts, starts and ends
function createFunctionRanges(parsed: ParsedFunctionRanges, lines: ReturnType<typeof createLineBoundaries>) {
    const ranges: FunctionRange[] = new Array(parsed.count);

    for (let i = 0; i < parsed.count; i++) {
        const callFrameStart = parsed.callFrameStart[i];
        const callFrameStartLine = lines.lineOf(callFrameStart);
        const start = parsed.start[i];
        const startLine = lines.lineOf(start);
        const end = parsed.end[i];
        const endLine = lines.lineOf(end);

        ranges[i] = {
            type: functionRangeTypes[parsed.type[i]],
            name: parsed.name[i] ?? '',
            defaultConstructor: parsed.defaultConstructor[i],
            callFrameStart,
            callFrameStartLine: callFrameStartLine + 1,
            callFrameStartColumn: lines.columnOf(callFrameStart, callFrameStartLine),
            start,
            startLine: startLine + 1,
            startColumn: lines.columnOf(start, startLine),
            end,
            endLine: endLine + 1,
            endColumn: lines.columnOf(end, endLine),
            selfSize: 0
        };
    }

    return ranges;
}

function buildFunctionRangesIndex({ ranges }: FunctionRanges) {
    const rangeStarts: number[] = [0];
    const rangeIndexes: number[] = [-1];
    const stack: number[] = [-1];
    let lastPos = 0;

    for (let i = 0; i < ranges.length; i++) {
        const range = ranges[i];

        while (stack.length > 1) {
            const top = stack[stack.length - 1];
            const end = ranges[top].end;

            if (end > range.callFrameStart) {
                break;
            }

            stack.pop();

            if (lastPos < end) {
                lastPos = end;
                rangeStarts.push(end);
                rangeIndexes.push(stack[stack.length - 1]);
            } else {
                rangeIndexes[rangeIndexes.length - 1] = stack[stack.length - 1];
            }
        }

        if (lastPos < range.callFrameStart) {
            lastPos = range.callFrameStart;
            rangeStarts.push(range.callFrameStart);
            rangeIndexes.push(i);
        } else {
            rangeIndexes[rangeIndexes.length - 1] = i;
        }

        stack.push(i);
    }

    while (stack.length > 1) {
        const top = stack[stack.length - 1];
        const end = ranges[top].end;

        stack.pop();

        if (lastPos < end) {
            lastPos = end;
            rangeStarts.push(end);
            rangeIndexes.push(stack[stack.length - 1]);
        } else {
            rangeIndexes[rangeIndexes.length - 1] = stack[stack.length - 1];
        }
    }

    return {
        starts: new Uint32Array(rangeStarts),
        indexes: new Int32Array(rangeIndexes)
    };
}
