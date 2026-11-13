import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
    createFunctionRangeColumns,
    parseScriptSourceRanges,
    readFunctionRanges,
    writeFunctionRanges,
    type FunctionRangeColumns,
    type FunctionRanges
} from '../misc/parse-script-source-ranges.js';
import { computeScriptSourceMetrics } from '../misc/source-text-metrics.js';
import { computeLineStarts } from '../misc/line-boundaries.js';
import type { ParseSourceWorkerScriptResult } from './types.js';
import { evaluateModule } from '../../../test/helpers/evaluate-module.js';

type Message = {
    scripts: ParseSourceWorkerScriptResult[];
    ranges: FunctionRangeColumns;
    starts: Uint32Array<ArrayBuffer>;
    indexes: Int32Array<ArrayBuffer>;
    lineStarts: Uint32Array;
    types: string[];
};
type Post = {
    message: Message;
    transfer: ArrayBuffer[];
    buffers: ArrayBuffer[];
};

// Buffers of the typed array columns of a message
function columnBuffers(message: Message) {
    const buffers: ArrayBuffer[] = [];
    const rangeColumns = Object.values(message.ranges);

    for (let i = 0; i < rangeColumns.length; i++) {
        const column = rangeColumns[i];

        if (ArrayBuffer.isView(column)) {
            buffers.push(column.buffer);
        }
    }

    buffers.push(message.starts.buffer, message.indexes.buffer, message.lineStarts.buffer);

    return buffers;
}

test('posts ranges, their indexes and line starts of all scripts in columns of one message with metrics', async () => {
    const sources = [
        'function outer() { return () => "\u0100"; }',
        '',
        'const text = "caf\u00e9";\r\nlet a;\n',
        'function broken(\u0100'
    ];
    const posts: Post[] = [];
    const postMessage = (message: Message, transfer: ArrayBuffer[]) => {
        // a clone brings the message into this realm, as a worker message does
        posts.push({
            message: structuredClone(message),
            transfer,
            buffers: columnBuffers(message)
        });
    };
    const handler = evaluateModule(new URL('./parse-source-worker.js', import.meta.url), {
        parseScriptSourceRanges,
        createFunctionRangeColumns,
        writeFunctionRanges,
        computeScriptSourceMetrics,
        computeLineStarts,
        postMessage
    }, 'onmessage');

    await handler({
        data: sources.map((source, id) => ({ id, source, url: 'fixture.js' }))
    });

    assert.equal(posts.length, 1);

    const { message, transfer, buffers } = posts[0];
    const [outer, empty, text, broken] = message.scripts;

    assert.deepEqual(message.scripts.map(script => script.id), [0, 1, 2, 3]);
    assert.deepEqual(message.types, ['FunctionDeclaration', 'ArrowFunctionExpression']);
    assert.deepEqual([...message.ranges.type], [0, 1]);
    assert.deepEqual(message.scripts.map(script => script.rangeCount), [2, 0, 0, 0]);

    // only the columns are transferred, no buffers per script
    assert.equal(transfer.length, buffers.length);

    for (let i = 0; i < buffers.length; i++) {
        assert.equal(transfer[i], buffers[i]);
    }

    assert.deepEqual(message.scripts.map(script => script.lineCount), [1, 1, 3, 1]);
    assert.deepEqual([...message.lineStarts], [0, 0, 0, 22, 29, 0]);

    let offset = 0;
    let indexOffset = 0;

    for (let i = 0; i < sources.length; i++) {
        const { parsed, error, rangeCount, indexCount } = message.scripts[i];
        const ranges: FunctionRanges = {
            parsed,
            ranges: readFunctionRanges(message.ranges, offset, rangeCount, message.types),
            starts: message.starts.subarray(indexOffset, indexOffset + indexCount),
            indexes: message.indexes.subarray(indexOffset, indexOffset + indexCount)
        };

        if (error !== undefined) {
            ranges.error = error;
        }

        offset += rangeCount;
        indexOffset += indexCount;
        assert.deepEqual(ranges, parseScriptSourceRanges(sources[i], 'fixture.js', true));
    }

    assert.deepEqual(outer.sourceMetrics, {
        bytesPerChar: 2,
        byteLength: 76,
        nonLatin1CodeUnits: 1,
        surrogatePairs: 0,
        selfSize: 14
    });
    assert.deepEqual(empty.sourceMetrics, {
        bytesPerChar: 1,
        byteLength: 0,
        nonLatin1CodeUnits: 0,
        surrogatePairs: 0,
        selfSize: 0
    });
    assert.deepEqual(text.sourceMetrics, {
        bytesPerChar: 1,
        byteLength: 29,
        nonLatin1CodeUnits: 0,
        surrogatePairs: 0,
        selfSize: 29
    });
    // an unparsed source has no exclusive size
    assert.equal(broken.parsed, false);
    assert.deepEqual(broken.sourceMetrics, {
        bytesPerChar: 2,
        byteLength: 34,
        nonLatin1CodeUnits: 1,
        surrogatePairs: 0,
        selfSize: null
    });
});
