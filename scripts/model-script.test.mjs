import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { model, raw } from '../build/cpupro-model-script.js';

test('the built model renders struct through the native query chain', async () => {
    const data = { nested: { value: 42 } };
    const result = await model.queryChain(() => data).render({ view: 'struct', expanded: 2 });

    assert.equal(result.text, '{\n    nested: {\n        value: 42\n    }\n}');
});

test('consoleLog forwards values to the console without changing the query receiver', context => {
    const log = context.mock.method(console, 'log', () => {});
    const data = { value: 42 };

    data.self = data;
    const result = model.query('consoleLog("label", 7)', data);
    const projected = model.query('consoleLog().value', data);

    assert.equal(result, data);
    assert.equal(projected, 42);
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [
        [data, 'label', 7],
        [data]
    ]);
});

test('consoleLog is not installed on the raw model', () => {
    assert.throws(() => raw.query('consoleLog()', {}), /consoleLog/);
});

test('renderToConsole uses the text view without Node inspection', async context => {
    const log = context.mock.method(console, 'log', () => {});

    await model.queryChain(() => ({ value: 42 })).renderToConsole('struct');

    assert.equal(log.mock.calls.length, 1);
    assert.deepEqual(log.mock.calls[0].arguments, ['{ value: 42 }']);
});

test('the built model loads and queries a local profile in Node', async () => {
    const filename = fileURLToPath(new URL('../app/demo/chromium.jsonxl', import.meta.url));

    try {
        await model.loadDataFromFile(filename);

        const entries = await model.queryChain('scopeBreakdown().callFrames.all.dict.entries[:2]');

        assert.equal(entries.length, 2);
        assert.ok(entries[0].entry);
        const result = await model.queryChain(() => entries).render({ view: 'struct', expanded: 2 });

        assert.ok(result.text.includes('[call-frame]'));
        assert.ok(result.text.includes('entryIndex:'));
    } finally {
        model.unloadData();
    }
});
