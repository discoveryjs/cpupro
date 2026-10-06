import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import jora from 'jora';
import * as scriptFunctions from '../prepare/misc/script-function-resolution.js';
import { methods } from '../jora/index.mjs';
import { createScript, OriginalScriptsMap, ProfileScriptsMap } from '../prepare/preprocessing/scripts.js';
import { parseScriptSourceRanges } from '../prepare/misc/parse-script-source-ranges.js';
import { Dictionary } from '../prepare/dictionary.js';
import { processScriptCompilation } from '../prepare/preprocessing/script-compilation.js';
import { computeScriptSourceMetrics } from '../prepare/misc/source-text-metrics.js';

let page;
vi.stubGlobal('discovery', { page: { define(name, config) {
    assert.equal(name, 'scripts');
    page = config;
} } });
try {
    await import('./all-scripts.js');
} finally {
    vi.unstubAllGlobals();
}

const query = jora.setup({ methods });
const prepare = page.content;

// the tests below exercise the rendering stage, the preparation stage is covered separately
page = { ...page, content: prepare.content };
const parser = vi.spyOn(scriptFunctions, 'prepareScriptSources').mockResolvedValue(undefined);
const list = async context => query(page.content.data)(await query(prepare.data)(null, context), context);

test('scripts page includes inactive source and excludes originals by default without CPU metric dependence', async () => {
    const dictionary = new Dictionary();
    const scripts = new ProfileScriptsMap(dictionary, new OriginalScriptsMap(dictionary), [
        { id: 1, url: 'active.js', source: 'function active() {}' },
        { id: 2, url: 'inactive.js', source: 'function idle() {}' }
    ]);
    for (const [, script] of scripts.entries()) {
        const parsed = parseScriptSourceRanges(script.source, script.url, true);
        script.sourceMetrics = computeScriptSourceMetrics(script.source, parsed.ranges);
        script.functionRanges = parsed.ranges;
    }
    const active = scripts.get(1);
    const range = active.functionRanges[0];
    const record = { scriptId: 1, start: range.callFrameStart, end: range.end, name: 'CompileFunction', duration: 1 };
    const compilation = processScriptCompilation([record], scripts).get(1);
    const original = createScript(3, 'original.ts', '');
    original.originalFor = active;
    const missing = createScript(4, 'missing.js');
    const thread = {
        scripts: [...dictionary.scripts, original, missing].map(script => ({ script, compilation: script === active ? compilation : null })),
        compilations: [record]
    };
    const context = { primaryProfile: { thread } };

    const rows = await list(context);
    const withOriginals = await list({ ...context, originals: true });
    const filtered = await list({ ...context, filter: /^active/ });

    assert.equal(rows.length, 3);
    assert.equal(withOriginals.length, 4);
    assert.equal(filtered.length, 1);
    assert.equal(rows[0].compiledBytes, range.selfSize);
    assert.equal(rows[1].compiledBytes, 0);
    assert.equal(rows[2].byteLength, null);
    assert.equal(query(page.content.content[0].data)(rows, context).at(-1).script, missing);
    const details = page.content.content[0].cols.find(column => column.header === 'Functions').details;
    assert.equal(query(details.data)(rows[0], context).length, 2);
    const totalBytes = rows.reduce((sum, row) => sum + (row.byteLength ?? 0), 0);
    assert.equal(totalBytes, active.source.length + scripts.get(2).source.length);

    thread.compilations = [];
    assert.ok((await list(context)).every(row => row.compiledBytes === null));
});

test('profile switches select thread scripts and thread compilation evidence for totals and details', async () => {
    const shared = createScript(1, 'shared.js', 'function shared() {}');
    const parsed = parseScriptSourceRanges(shared.source, shared.url, true);
    shared.functionRanges = parsed.ranges;
    shared.sourceMetrics = computeScriptSourceMetrics(shared.source, parsed.ranges);
    const range = parsed.ranges[0];
    const compilationRecord = { scriptId: 7, start: range.callFrameStart, end: range.end, name: 'CompileFunction', duration: 1 };
    const compile = processScriptCompilation([compilationRecord], new Map([[7, shared]])).get(7);
    const parseRecord = { ...compilationRecord, scriptId: 42, name: 'PreParse' };
    const preparse = processScriptCompilation([parseRecord], new Map([[42, shared]])).get(42);
    const original = createScript(2, 'original.ts', '');
    original.originalFor = shared;
    const privateScript = createScript(3, 'private.js', '');
    const first = { scripts: [{ script: shared, compilation: compile }, { script: original, compilation: null }], compilations: [compilationRecord] };
    const second = { scripts: [{ script: shared, compilation: preparse }, { script: privateScript, compilation: null }], compilations: [parseRecord] };
    const empty = { scripts: [{ script: shared, compilation: null }], compilations: [] };
    const session = { shared: { scripts: [shared, original, privateScript] }, processes: [{ threads: [first, second, empty] }] };
    const context = { data: { defaultSession: session }, primaryProfile: { thread: first } };
    const details = page.content.content[0].cols.find(column => column.header === 'Functions').details;
    const rows = () => list(context);

    assert.deepEqual((await rows()).map(row => row.script), [shared]);
    assert.equal((await rows())[0].compiledBytes, range.selfSize);
    assert.equal(query(details.data)((await rows())[0], context).find(row => row.start === range.callFrameStart).state, 'compiled');
    context.primaryProfile = { thread: second };
    assert.deepEqual((await rows()).map(row => row.script), [shared, privateScript]);
    assert.equal((await rows())[0].compiledBytes, 0);
    assert.equal(query(details.data)((await rows())[0], context).find(row => row.start === range.callFrameStart).state, 'pre-parsed');
    assert.deepEqual((await list({ ...context, originals: true })).map(row => row.script), [shared, privateScript]);
    context.primaryProfile = { thread: empty };
    assert.equal((await rows())[0].compiledBytes, null);
    assert.ok(query(details.data)((await rows())[0], context).every(row => row.state === 'unobserved'));
    assert.deepEqual(await list({ ...context, primaryProfile: null }), []);
});

test.each(['', '/* caf\u00e9 */', '/* a\u044f\ud83d\ude00 */'])('storage details show code-unit composition and whole-string overhead: %s', source => {
    const script = createScript(1, 'fixture.js', source);
    const parsed = parseScriptSourceRanges(source, script.url, true);
    script.sourceMetrics = computeScriptSourceMetrics(source, parsed.ranges);
    const column = page.content.content[0].cols[1];

    const details = query(column.details.data)({ script });

    assert.equal(details.codeUnits, source.length);
    assert.equal(details.codePoints, Array.from(source).length);
    assert.equal(details.groups[0].count + details.groups[1].count, source.length);
    assert.equal(details.groups[1].count, script.sourceMetrics.nonLatin1CodeUnits);
    assert.equal(details.supplementary, script.sourceMetrics.surrogatePairs);
    assert.equal(details.extraBytes, script.sourceMetrics.bytesPerChar === 2 ? source.length : 0);
    assert.ok(details.groups.every(group => Number.isFinite(group.fraction)));
    assert.equal(query(column.detailsWhen)({ script: createScript(2, 'missing.js') }), null);
});

test('UTF chars column counts non-Latin-1 code points and sorts missing source last', () => {
    const column = page.content.content[0].cols.find(column => column.header.text === 'UTF chars');
    const rows = [null, '/* caf\u00e9 */', '/* \u044f\ud83d\ude00 */', '', '/* \\u0100 */'].map((source, index) => {
        const script = createScript(index + 1, 'fixture.js', source);
        if (source !== null) {
            const ranges = parseScriptSourceRanges(source, script.url, true).ranges;
            script.sourceMetrics = computeScriptSourceMetrics(source, ranges);
        }
        return { script };
    });

    const counts = rows.map(row => query(column.data)(row));
    const sorted = query(`sort(${column.sorting})`)(rows);

    assert.deepEqual(counts, [null, 0, 2, 0, 0]);
    assert.equal(sorted[0], rows[2]);
    assert.equal(sorted.at(-1), rows[0]);
    assert.deepEqual(counts.map(count => query(column.content.slice('text-numeric:'.length))(count)), ['Unavailable', 0, 2, 0, 0]);
});

test('Unicode occurrence details preserve codes, offsets, repeated characters and exact context', () => {
    const before = 'a'.repeat(40);
    const after = 'b'.repeat(40);
    const source = '\u044f' + before + '\ud83d\ude00' + after + '\u044f';
    const occurrences = methods.sourceUnicodeCharacters(source);

    assert.deepEqual(occurrences.map(({ character, code, offset }) => ({ character, code, offset })), [
        { character: '\u044f', code: 'U+044F', offset: 0 },
        { character: '\ud83d\ude00', code: 'U+1F600', offset: 41 },
        { character: '\u044f', code: 'U+044F', offset: 83 }
    ]);
    assert.equal(occurrences[0].fragment, '\u044f' + 'a'.repeat(32));
    assert.equal(occurrences[1].fragment, 'a'.repeat(32) + '\ud83d\ude00' + 'b'.repeat(32));
    assert.equal(occurrences[2].fragment, 'b'.repeat(32) + '\u044f');
    assert.deepEqual(methods.sourceUnicodeCharacters('caf\u00e9 \\u044f'), []);
    assert.deepEqual(methods.sourceUnicodeCharacters(null), []);

    for (const entry of occurrences) {
        assert.equal(entry.fragment.slice(entry.start, entry.end), entry.character);
    }
});

test('Unicode context counts code points across newlines without splitting surrogate pairs', () => {
    const prefix = '\ud83d\ude00'.repeat(33);
    const suffix = '\ud834\udd1e'.repeat(33);
    const source = prefix + '\n\u0100\n' + suffix;
    const entry = methods.sourceUnicodeCharacters(source).find(entry => entry.code === 'U+0100');

    assert.equal(entry.fragment, '\ud83d\ude00'.repeat(31) + '\n\u0100\n' + '\ud834\udd1e'.repeat(31));
    assert.equal(Array.from(entry.fragment).length, 65);
    assert.equal(entry.fragment.slice(entry.start, entry.end), '\u0100');
    assert.equal(methods.sourceUnicodeCharacters('\ud800')[0].code, 'U+D800');
});

test('Storage and UTF chars details scan the selected source and share occurrence rows', () => {
    const script = createScript(1, 'fixture.js', '/* \u044f\ud83d\ude00 */');
    script.functionRanges = parseScriptSourceRanges(script.source, script.url, true);
    script.sourceMetrics = computeScriptSourceMetrics(script.source, script.functionRanges);
    const columns = page.content.content[0].cols;
    const storage = columns.find(column => column.header === 'Storage');
    const utf = columns.find(column => column.header.text === 'UTF chars');
    const context = query(utf.context)({ script });
    const count = query(utf.data)({ script }, context);
    const utfInput = query(utf.details.data)(count, context);
    const storageInput = query(storage.details.data)({ script });
    const table = utf.details.content;

    assert.equal(query(utf.detailsWhen)(count), true);
    assert.equal(query(utf.detailsWhen)(0), false);
    assert.equal(query(utf.detailsWhen)(null), false);
    assert.equal(table, storage.details.content.at(-1));
    const rows = query(table.data)(utfInput);
    assert.deepEqual(rows, query(table.data)(storageInput));
    assert.equal(rows.length, count);
    assert.deepEqual(rows.map(row => row.code), ['U+044F', 'U+1F600']);
    assert.deepEqual(query(table.cols[3].content.data)(rows[1]), {
        content: script.source,
        refs: [{ range: [4, 6], className: 'utf-character' }]
    });
});

test('preparation stage parses only listed scripts and resolves to the same entries', async () => {
    const dictionary = new Dictionary();
    const scripts = new ProfileScriptsMap(dictionary, new OriginalScriptsMap(dictionary), [
        { id: 1, url: 'listed.js', source: 'function listed() {}' },
        { id: 2, url: 'other.js', source: 'function other() {}' }
    ]);
    const original = createScript(3, 'original.ts', 'function original() {}');
    original.originalFor = scripts.get(1);
    const thread = { scripts: [scripts.get(1), scripts.get(2), original].map(script => ({ script, compilation: null })) };
    const parsed = [];
    parser.mockClear();
    parser.mockImplementation(async input => {
        parsed.push(...[...input].map(script => script.url));
    });

    try {
        const entries = query(prepare.data)(null, { primaryProfile: { thread }, filter: /^listed/ });

        assert.ok(entries instanceof Promise);
        assert.deepEqual((await entries).map(entry => entry.script.url), ['listed.js']);
        assert.deepEqual(parsed, ['listed.js']);
        await query(prepare.data)(null, { primaryProfile: { thread }, originals: true });
        assert.deepEqual(parsed.slice(1), ['listed.js', 'other.js', 'original.ts']);
    } finally {
        parser.mockResolvedValue(undefined);
    }
});
