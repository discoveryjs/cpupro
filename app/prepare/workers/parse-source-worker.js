import { createFunctionRangeColumns, parseScriptSourceRanges, writeFunctionRanges } from '../misc/parse-script-source-ranges.js';
import { computeScriptSourceMetrics } from '../misc/source-text-metrics.js';
import { computeLineStarts } from '../misc/line-boundaries.js';

onmessage = async function(event) {
    const { data: scripts } = event;
    const result = [];
    const transferable = [];
    const scriptLineStarts = [];
    let rangeCount = 0;
    let lineCount = 0;

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
            ranges: functionRanges,
            rangeCount: functionRanges.ranges.length,
            lineCount: lineStarts.length
        });
        scriptLineStarts.push(lineStarts);
        transferable.push(
            functionRanges.starts.buffer,
            functionRanges.indexes.buffer,
            functionRanges.parents.buffer
        );
        rangeCount += functionRanges.ranges.length;
        lineCount += lineStarts.length;
    }

    // Ranges of all the scripts are posted as columns, since a structured clone of range objects
    // or of typed arrays per script costs several times more than a transfer of a few large arrays
    const ranges = createFunctionRangeColumns(rangeCount);
    const types = new Map();
    let offset = 0;

    const columns = Object.values(ranges);

    for (let i = 0; i < result.length; i++) {
        const script = result[i];

        writeFunctionRanges(ranges, offset, script.ranges.ranges, types);
        offset += script.rangeCount;
        script.ranges.ranges = [];
    }

    for (let i = 0; i < columns.length; i++) {
        if (ArrayBuffer.isView(columns[i])) {
            transferable.push(columns[i].buffer);
        }
    }

    // Line starts of all the scripts are posted as a column for the same reason
    const lineStarts = new Uint32Array(lineCount);

    for (let i = 0, lineOffset = 0; i < scriptLineStarts.length; i++) {
        lineStarts.set(scriptLineStarts[i], lineOffset);
        lineOffset += scriptLineStarts[i].length;
    }

    transferable.push(lineStarts.buffer);

    postMessage({
        scripts: result,
        ranges,
        lineStarts,
        types: [...types.keys()]
    }, transferable);
};
