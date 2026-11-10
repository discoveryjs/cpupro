import { createFunctionRangeColumns, parseScriptSourceRanges, writeFunctionRanges } from '../misc/parse-script-source-ranges.js';
import { computeScriptSourceMetrics } from '../misc/source-text-metrics.js';

onmessage = async function(event) {
    const { data: scripts } = event;
    const result = [];
    const transferable = [];
    let rangeCount = 0;

    for (const { id, url, source } of scripts) {
        const functionRanges = parseScriptSourceRanges(source, url, true);
        const sourceMetrics = computeScriptSourceMetrics(source, functionRanges.parsed ? functionRanges.ranges : null);

        result.push({
            id,
            sourceMetrics,
            ranges: functionRanges,
            rangeCount: functionRanges.ranges.length
        });
        transferable.push(
            functionRanges.starts.buffer,
            functionRanges.indexes.buffer,
            functionRanges.parents.buffer
        );
        rangeCount += functionRanges.ranges.length;
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

    postMessage({
        scripts: result,
        ranges,
        types: [...types.keys()]
    }, transferable);
};
