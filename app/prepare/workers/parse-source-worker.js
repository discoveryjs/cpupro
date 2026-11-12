import { createFunctionRangeColumns, parseScriptSourceRanges, writeFunctionRanges } from '../misc/parse-script-source-ranges.js';
import { computeScriptSourceMetrics } from '../misc/source-text-metrics.js';
import { computeLineStarts } from '../misc/line-boundaries.js';

onmessage = async function(event) {
    const { data: scripts } = event;
    const result = [];
    const scriptRanges = [];
    const scriptLineStarts = [];

    for (const { id, url, source } of scripts) {
        const functionRanges = parseScriptSourceRanges(source, url, true);
        const parsedRanges = functionRanges.parsed
            ? functionRanges.ranges
            : null;
        const sourceMetrics = computeScriptSourceMetrics(source, parsedRanges);
        // the main thread looks up offsets of lines and columns in the sources it gets parsed
        const lineStarts = computeLineStarts(source);

        result.push({
            id,
            sourceMetrics,
            parsed: functionRanges.parsed,
            error: functionRanges.error,
            rangeCount: functionRanges.ranges.length,
            indexCount: functionRanges.starts.length,
            lineCount: lineStarts.length
        });
        scriptRanges.push(functionRanges);
        scriptLineStarts.push(lineStarts);
    }

    const columns = createColumns(scriptRanges, scriptLineStarts);

    postMessage({
        scripts: result,
        ...columns
    }, columnBuffers(columns));
};

// Ranges, range indexes and line starts of all the scripts are posted as columns, since a structured clone
// of range objects or a transfer of typed arrays per script costs several times more than a transfer
// of a few large arrays
function createColumns(scriptRanges, scriptLineStarts) {
    let rangeCount = 0;
    let indexCount = 0;
    let lineCount = 0;

    for (let i = 0; i < scriptRanges.length; i++) {
        rangeCount += scriptRanges[i].ranges.length;
        indexCount += scriptRanges[i].starts.length;
        lineCount += scriptLineStarts[i].length;
    }

    const ranges = createFunctionRangeColumns(rangeCount);
    const parents = new Int32Array(rangeCount);
    const starts = new Uint32Array(indexCount);
    const indexes = new Int32Array(indexCount);
    const lineStarts = new Uint32Array(lineCount);
    const types = new Map();

    for (let i = 0, offset = 0, indexOffset = 0, lineOffset = 0; i < scriptRanges.length; i++) {
        const functionRanges = scriptRanges[i];

        writeFunctionRanges(ranges, offset, functionRanges.ranges, types);
        parents.set(functionRanges.parents, offset);
        starts.set(functionRanges.starts, indexOffset);
        indexes.set(functionRanges.indexes, indexOffset);
        lineStarts.set(scriptLineStarts[i], lineOffset);
        offset += functionRanges.ranges.length;
        indexOffset += functionRanges.starts.length;
        lineOffset += scriptLineStarts[i].length;
    }

    return {
        ranges,
        parents,
        starts,
        indexes,
        lineStarts,
        types: [...types.keys()]
    };
}

// Buffers of the typed array columns, which are transferred rather than copied
function columnBuffers(columns) {
    const buffers = [];
    const rangeColumns = Object.values(columns.ranges);

    for (let i = 0; i < rangeColumns.length; i++) {
        if (ArrayBuffer.isView(rangeColumns[i])) {
            buffers.push(rangeColumns[i].buffer);
        }
    }

    buffers.push(columns.parents.buffer, columns.starts.buffer, columns.indexes.buffer, columns.lineStarts.buffer);

    return buffers;
}
