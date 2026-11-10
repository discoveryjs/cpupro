import assert from 'node:assert/strict';
import { test } from 'vitest';
import { decodeFunctionRangeTypes, parseScriptSourceRanges } from '../misc/parse-script-source-ranges.js';
import { computeScriptSourceMetrics } from '../misc/source-text-metrics.js';
import type { ParseSourceWorkerScriptResult } from './types.js';
import { evaluateModule } from '../../../test/helpers/evaluate-module.js';

type Message = { scripts: ParseSourceWorkerScriptResult[]; types: string[] };

test('posts one message with type-encoded function ranges and source metrics of every script', async () => {
    const sources = ['function outer() { return () => "\u0100"; }', '', 'const text = "caf\u00e9";', 'function broken(\u0100'];
    const posts: { message: Message; transfer: ArrayBuffer[]; buffers: ArrayBuffer[] }[] = [];
    const handler = evaluateModule(new URL('./parse-source-worker.js', import.meta.url), {
        parseScriptSourceRanges,
        computeScriptSourceMetrics,
        postMessage(message: Message, transfer: ArrayBuffer[]) {
            const buffers: ArrayBuffer[] = [];

            for (const script of message.scripts) {
                buffers.push(script.ranges.starts.buffer, script.ranges.indexes.buffer, script.ranges.parents.buffer);
            }

            // a clone brings the message into this realm, as a worker message does
            posts.push({ message: structuredClone(message), transfer, buffers });
        }
    }, 'onmessage');

    await handler({ data: sources.map((source, id) => ({ id, source, url: 'fixture.js' })) });

    assert.equal(posts.length, 1);

    const { message, transfer, buffers } = posts[0];
    const [outer, empty, text, broken] = message.scripts;

    assert.deepEqual(message.scripts.map(script => script.id), [0, 1, 2, 3]);
    assert.deepEqual(message.types, ['FunctionDeclaration', 'ArrowFunctionExpression']);
    assert.deepEqual(outer.ranges.ranges.map(range => range.type), [0, 1]);

    // index buffers of every script are transferred rather than copied
    assert.equal(transfer.length, 12);

    for (let i = 0; i < buffers.length; i++) {
        assert.equal(transfer[i], buffers[i]);
    }

    for (let i = 0; i < sources.length; i++) {
        const ranges = decodeFunctionRangeTypes(message.scripts[i].ranges, message.types);

        assert.deepEqual(ranges, parseScriptSourceRanges(sources[i], 'fixture.js', true));
    }

    assert.deepEqual(outer.sourceMetrics, { bytesPerChar: 2, byteLength: 76, nonLatin1CodeUnits: 1, surrogatePairs: 0, selfSize: 14 });
    assert.deepEqual(empty.sourceMetrics, { bytesPerChar: 1, byteLength: 0, nonLatin1CodeUnits: 0, surrogatePairs: 0, selfSize: 0 });
    assert.deepEqual(text.sourceMetrics, { bytesPerChar: 1, byteLength: 20, nonLatin1CodeUnits: 0, surrogatePairs: 0, selfSize: 20 });
    // an unparsed source has no exclusive size
    assert.equal(broken.ranges.parsed, false);
    assert.deepEqual(broken.sourceMetrics, { bytesPerChar: 2, byteLength: 34, nonLatin1CodeUnits: 1, surrogatePairs: 0, selfSize: null });
});
