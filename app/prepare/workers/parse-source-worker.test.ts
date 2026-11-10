import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
    createFunctionRangeColumns,
    parseScriptSourceRanges,
    readFunctionRanges,
    writeFunctionRanges,
    type FunctionRangeColumns
} from '../misc/parse-script-source-ranges.js';
import { computeScriptSourceMetrics } from '../misc/source-text-metrics.js';
import type { ParseSourceWorkerScriptResult } from './types.js';
import { evaluateModule } from '../../../test/helpers/evaluate-module.js';

type Message = {
    scripts: ParseSourceWorkerScriptResult[];
    ranges: FunctionRangeColumns;
    types: string[];
};
type Post = {
    message: Message;
    transfer: ArrayBuffer[];
    buffers: ArrayBuffer[];
};

test('posts one message with function ranges in columns and source metrics of every script', async () => {
    const sources = [
        'function outer() { return () => "\u0100"; }',
        '',
        'const text = "caf\u00e9";',
        'function broken(\u0100'
    ];
    const posts: Post[] = [];
    const postMessage = (message: Message, transfer: ArrayBuffer[]) => {
        const buffers: ArrayBuffer[] = [];
        const columns = Object.values(message.ranges);

        for (let i = 0; i < message.scripts.length; i++) {
            const ranges = message.scripts[i].ranges;

            buffers.push(ranges.starts.buffer, ranges.indexes.buffer, ranges.parents.buffer);
        }

        for (let i = 0; i < columns.length; i++) {
            const column = columns[i];

            if (ArrayBuffer.isView(column)) {
                buffers.push(column.buffer);
            }
        }

        // a clone brings the message into this realm, as a worker message does
        posts.push({ message: structuredClone(message), transfer, buffers });
    };
    const handler = evaluateModule(new URL('./parse-source-worker.js', import.meta.url), {
        parseScriptSourceRanges,
        createFunctionRangeColumns,
        writeFunctionRanges,
        computeScriptSourceMetrics,
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

    // index buffers of every script and range columns are transferred rather than copied
    assert.equal(transfer.length, 4 * 3 + 12);

    for (let i = 0; i < buffers.length; i++) {
        assert.equal(transfer[i], buffers[i]);
    }

    for (let i = 0, offset = 0; i < sources.length; i++) {
        const { ranges, rangeCount } = message.scripts[i];

        ranges.ranges = readFunctionRanges(message.ranges, offset, rangeCount, message.types);
        offset += rangeCount;
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
        byteLength: 20,
        nonLatin1CodeUnits: 0,
        surrogatePairs: 0,
        selfSize: 20
    });
    // an unparsed source has no exclusive size
    assert.equal(broken.ranges.parsed, false);
    assert.deepEqual(broken.sourceMetrics, {
        bytesPerChar: 2,
        byteLength: 34,
        nonLatin1CodeUnits: 1,
        surrogatePairs: 0,
        selfSize: null
    });
});
