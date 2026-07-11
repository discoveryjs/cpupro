import { parseScriptSourceRanges } from '../misc/parse-script-source-ranges.js';

onmessage = async function(event) {
    const { data: scripts } = event;
    const result = [];
    const transferable = [];

    for (const { id, url, source } of scripts) {
        const functionRanges = parseScriptSourceRanges(source, url, true);
        result.push({
            id,
            ranges: functionRanges
        });
        if (functionRanges.starts.buffer) {
            transferable.push(
                functionRanges.starts.buffer,
                functionRanges.indexes.buffer
            );
        }
    }

    postMessage(result, transferable);
};
