import { parseScriptSourceRanges } from '../misc/parse-script-source-ranges.js';
import { computeScriptSourceMetrics } from '../misc/source-text-metrics.js';

onmessage = async function(event) {
    const { data: scripts } = event;
    const result = [];
    const transferable = [];
    const types = new Map();

    for (const { id, url, source } of scripts) {
        const functionRanges = parseScriptSourceRanges(source, url, true);
        const sourceMetrics = computeScriptSourceMetrics(source, functionRanges.ranges);

        for (const range of functionRanges.ranges) {
            const type = range.type;
            let typeIndex = types.get(type);

            if (typeIndex === undefined) {
                typeIndex = types.size;
                types.set(type, typeIndex);
            }

            range.type = typeIndex;
        }

        result.push({
            id,
            sourceMetrics,
            ranges: functionRanges
        });
        if (functionRanges.starts.buffer) {
            transferable.push(
                functionRanges.starts.buffer,
                functionRanges.indexes.buffer
            );
        }
    }

    postMessage({
        scripts: result,
        types: [...types.keys()]
    }, transferable);
};
