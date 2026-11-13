import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import jora from 'jora';
import * as scriptFunctions from '../prepare/misc/script-function-resolution.js';
import { methods } from '../jora/index.mjs';
import { createScript } from '../prepare/preprocessing/scripts.js';
import { prepareCompilationSubjects, processScriptCompilation } from '../prepare/preprocessing/script-compilation.js';
import { createCompilationRecord } from '../../test/fixtures/compilation.js';
import { parseScriptFixture } from '../../test/fixtures/scripts.js';
import { findContent, findView, contentQuery, findColumn } from '../../test/helpers/view-config.js';

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
// Byte sizes are compared unformatted
const bytesQuery = jora.setup({ methods: { ...methods, bytes: value => value } });

// Scripts are listed and parsed by the preparation stage, then summarized by the rendering stage
const prepare = page.content;
const render = prepare.content;
const table = findView(page, { className: 'all-page-table' });
const summary = findView(page, { className: 'all-page-summary scripts-summary' });

// Sources are parsed by the tests, the preparation stage is checked separately
const parser = vi.spyOn(scriptFunctions, 'prepareScriptSources').mockResolvedValue(undefined);

async function listScripts(context) {
    const entries = await query(prepare.data)(null, context);

    return query(render.data)(entries, context);
}

function parsedScript(id, url, source) {
    const script = createScript(id, url, source);

    parseScriptFixture(script);

    return script;
}

// A thread of a script compiled by a stage of its first function, when it's given
function createThread(script, stage) {
    if (stage === null) {
        return { scripts: [{ script, compilation: null }], compilations: [] };
    }

    const range = script.functionRanges[0];
    const record = createCompilationRecord({
        name: stage,
        scriptId: script.id,
        start: range.callFrameStart,
        end: range.end
    });
    const compilation = processScriptCompilation(prepareCompilationSubjects([record]), new Map([[script.id, script]])).get(script.id);

    return { scripts: [{ script, compilation }], compilations: [record] };
}

// Scripts of a thread: a Latin-1 one, a UTF-16 one, a source-map original of the first one, an entry
// without a script and a script without source
function createScriptsThread() {
    const latin1 = parsedScript(1, 'latin1.js', 'function latin1() {}');
    const utf16 = parsedScript(2, 'utf16.js', 'function utf16() { return "\u044f"; }');
    const original = parsedScript(3, 'original.ts', 'function original() {}');

    original.originalFor = latin1;

    return {
        scripts: [
            { script: latin1, compilation: null },
            { script: null, compilation: null },
            { script: utf16, compilation: null },
            { script: original, compilation: null },
            { script: createScript(4, 'missing.js'), compilation: null }
        ],
        compilations: []
    };
}

// A row of the UTF chars column
function utfRow(nonLatin1CodeUnits, surrogatePairs) {
    return { script: { sourceMetrics: { nonLatin1CodeUnits, surrogatePairs } } };
}

test.each([
    ['without originals', {}, ['latin1.js', 'utf16.js', 'missing.js']],
    ['with originals', { originals: true }, ['latin1.js', 'utf16.js', 'original.ts', 'missing.js']],
    ['matching the filter', { filter: /^utf/ }, ['utf16.js']],
    ['with UTF-16 storage only', { utfOnly: true }, ['utf16.js']]
])('the scripts of the scope thread are listed %s', async (_, options, urls) => {
    const thread = createScriptsThread();
    const rows = await listScripts({ primaryProfile: { thread }, ...options });

    assert.deepEqual(rows.map(row => row.script.url), urls);
});

test('a scope profile without a thread lists no scripts', async () => {
    assert.deepEqual(await listScripts({ primaryProfile: null }), []);
});

test('the preparation stage parses the listed scripts and resolves to their entries', async () => {
    const thread = createScriptsThread();
    const parsed = [];
    const parse = async scripts => {
        for (let i = 0; i < scripts.length; i++) {
            parsed.push(scripts[i].url);
        }
    };

    parser.mockImplementation(parse);

    try {
        const entries = query(prepare.data)(null, { primaryProfile: { thread }, filter: /^utf/ });

        assert.ok(entries instanceof Promise);

        const resolved = await entries;

        assert.equal(resolved.length, 1);
        assert.equal(resolved[0], thread.scripts[2]);
        assert.deepEqual(parsed, ['utf16.js']);

        await query(prepare.data)(null, { primaryProfile: { thread }, originals: true });
        assert.deepEqual(parsed, ['utf16.js', 'latin1.js', 'utf16.js', 'original.ts', 'missing.js']);
    } finally {
        parser.mockResolvedValue(undefined);
    }
});

test('a script without source is listed with unavailable sizes', async () => {
    const thread = createScriptsThread();
    const rows = await listScripts({ primaryProfile: { thread }, filter: /^missing/ });

    assert.deepEqual(rows.map(row => [row.byteLength, row.bytesPerChar, row.functions, row.compiledBytes]), [
        [null, null, null, null]
    ]);
});

test('compiled bytes are observed for listed scripts of a thread with compilation events only', async () => {
    const thread = createThread(parsedScript(1, 'compiled.js', 'function compiled() {}'), 'CompileFunction');
    const idle = parsedScript(2, 'idle.js', 'function idle() {}');
    const original = parsedScript(3, 'original.ts', 'function original() {}');

    original.originalFor = idle;
    thread.scripts.push({ script: idle, compilation: null }, { script: original, compilation: null });

    const rows = await listScripts({ primaryProfile: { thread }, originals: true });

    // Own bytes of a function span from its parameters to its end, "() {}"
    assert.deepEqual(rows.map(row => row.compiledBytes), [5, 0, null]);

    thread.compilations = [];

    assert.deepEqual((await listScripts({ primaryProfile: { thread } })).map(row => row.compiledBytes), [null, null]);
});

test.each([
    ['compiled', 'CompileFunction', 5, 'compiled'],
    ['pre-parsed', 'PreParse', 0, 'pre-parsed'],
    ['not compiled', null, null, 'unobserved']
])('a shared script shows its compilation in the scope thread: %s', async (_, stage, compiledBytes, state) => {
    const shared = parsedScript(1, 'shared.js', 'function shared() {}');
    const functions = query(findColumn(table, 'Functions').details.data);
    const context = { primaryProfile: { thread: createThread(shared, 'CompileFunction') } };

    // The script is listed for a thread where it's compiled first
    await listScripts(context);
    context.primaryProfile = { thread: createThread(shared, stage) };

    const [scriptRow] = await listScripts(context);

    assert.equal(scriptRow.compiledBytes, compiledBytes);
    assert.deepEqual(functions(scriptRow, context).map(entry => [entry.name, entry.state]), [
        ['(script)', 'unobserved'],
        ['shared', state]
    ]);
});

test('scripts are sorted by source bytes, unavailable ones last, then by their urls', () => {
    const rows = [
        { byteLength: null, script: { url: 'a.js' } },
        { byteLength: 5, script: { url: 'b.js' } },
        { byteLength: 20, script: { url: 'c10.js' } },
        { byteLength: 20, script: { url: 'c9.js' } }
    ];

    assert.deepEqual(query(table.data)(rows), [rows[3], rows[2], rows[1], rows[0]]);
});

test.each([
    ['Source bytes', { byteLength: 10 }, { byteLength: 20 }],
    ['Storage', { bytesPerChar: 1 }, { bytesPerChar: 2 }],
    ['UTF chars', utfRow(4, 2), utfRow(3, 0)],
    ['Functions', { functions: 1 }, { functions: 2 }],
    ['Observed compiled', { compiledBytes: 1 }, { compiledBytes: 2 }],
    ['%', { compiledBytes: 1, byteLength: 4 }, { compiledBytes: 1, byteLength: 2 }]
])('the %s column sorts larger values first', (header, smaller, larger) => {
    assert.deepEqual(query(`sort(${findColumn(table, header).sorting})`)([smaller, larger]), [larger, smaller]);
});

test.each([
    ['Latin-1', 1],
    ['UTF-16', 2],
    ['Unavailable', null]
])('the storage of a script is %s', (label, bytesPerChar) => {
    assert.equal(contentQuery(bytesQuery, findColumn(table, 'Storage').content)({ bytesPerChar }), label);
});

test.each([
    ['observed compiled bytes of source bytes', 5, 20, '25.0%'],
    ['unavailable without compilation', null, 20, '–'],
    ['unavailable without source bytes', 0, 0, '–']
])('the compiled share of a script is %s', (_, compiledBytes, byteLength, share) => {
    assert.equal(contentQuery(bytesQuery, findColumn(table, '%').content)({ compiledBytes, byteLength }), share);
});

test.each([
    ['observed compilation', [20, null, 0], 20],
    ['no observed compilation', [null, null, null], 'Unavailable']
])('the summary totals the scripts, their source bytes and %s', (_, compiledBytes, compiled) => {
    const rows = [
        { byteLength: 20, compiledBytes: compiledBytes[0] },
        { byteLength: null, compiledBytes: compiledBytes[1] },
        { byteLength: 5, compiledBytes: compiledBytes[2] }
    ];

    assert.equal(contentQuery(bytesQuery, findContent(summary, 'text-numeric:size()'))(rows), 3);
    assert.equal(contentQuery(bytesQuery, findContent(summary, 'text:sum(=>byteLength'))(rows), 25);
    assert.equal(contentQuery(bytesQuery, findContent(summary, 'text:.[compiledBytes'))(rows), compiled);
});

test.each([
    ['', [0, 0, 0, 0], [[0, 0], [0, 0]]],
    ['/* caf\u00e9 */', [10, 10, 0, 0], [[10, 1], [0, 0]]],
    ['/* a\u044f\ud83d\ude00 */', [10, 9, 1, 10], [[7, 0.7], [3, 0.3]]]
])('storage details show code-unit composition and whole-string overhead: %s', (source, counts, groups) => {
    const script = parsedScript(1, 'fixture.js', source);
    const column = findColumn(table, 'Storage');
    const details = query(column.details.data)({ script });

    assert.deepEqual([details.codeUnits, details.codePoints, details.supplementary, details.extraBytes], counts);
    assert.deepEqual(details.groups.map(group => [group.count, group.fraction]), groups);
    assert.equal(query(column.detailsWhen)({ script: createScript(2, 'missing.js') }), null);
});

test('UTF chars column counts non-Latin-1 code points and sorts missing source last', () => {
    const column = findColumn(table, 'UTF chars');
    const sources = [null, '/* caf\u00e9 */', '/* \u044f\ud83d\ude00 */', '', '/* \\u0100 */'];
    const rows = [];

    for (let i = 0; i < sources.length; i++) {
        const script = createScript(i + 1, 'fixture.js', sources[i]);

        if (sources[i] !== null) {
            parseScriptFixture(script);
        }

        rows.push({ script });
    }

    const counts = rows.map(row => query(column.data)(row));
    const sorted = query(`sort(${column.sorting})`)(rows);
    const text = query(column.content.slice('text-numeric:'.length));

    assert.deepEqual(counts, [null, 0, 2, 0, 0]);
    assert.equal(sorted[0], rows[2]);
    assert.equal(sorted.at(-1), rows[0]);
    assert.deepEqual(counts.map(count => text(count)), ['Unavailable', 0, 2, 0, 0]);
});

test('Unicode occurrence details preserve codes, offsets, repeated characters and exact context', () => {
    const before = 'a'.repeat(40);
    const after = 'b'.repeat(40);
    const source = '\u044f' + before + '\ud83d\ude00' + after + '\u044f';
    const occurrences = methods.sourceUnicodeCharacters(source);

    assert.deepEqual(occurrences.map(entry => [entry.character, entry.code, entry.offset]), [
        ['\u044f', 'U+044F', 0],
        ['\ud83d\ude00', 'U+1F600', 41],
        ['\u044f', 'U+044F', 83]
    ]);
    assert.equal(occurrences[0].fragment, '\u044f' + 'a'.repeat(32));
    assert.equal(occurrences[1].fragment, 'a'.repeat(32) + '\ud83d\ude00' + 'b'.repeat(32));
    assert.equal(occurrences[2].fragment, 'b'.repeat(32) + '\u044f');
    assert.deepEqual(methods.sourceUnicodeCharacters('caf\u00e9 \\u044f'), []);
    assert.deepEqual(methods.sourceUnicodeCharacters(null), []);

    for (let i = 0; i < occurrences.length; i++) {
        const entry = occurrences[i];

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
    const script = parsedScript(1, 'fixture.js', '/* \u044f\ud83d\ude00 */');
    const storage = findColumn(table, 'Storage');
    const utf = findColumn(table, 'UTF chars');
    const context = query(utf.context)({ script });
    const count = query(utf.data)({ script }, context);
    const utfInput = query(utf.details.data)(count, context);
    const storageInput = query(storage.details.data)({ script });
    const occurrences = utf.details.content;
    const sourceContext = findView(occurrences, { className: 'utf-source' });

    assert.equal(query(utf.detailsWhen)(count), true);
    assert.equal(query(utf.detailsWhen)(0), false);
    assert.equal(query(utf.detailsWhen)(null), false);
    assert.equal(occurrences, storage.details.content.at(-1));

    const rows = query(occurrences.data)(utfInput);

    assert.deepEqual(rows, query(occurrences.data)(storageInput));
    assert.equal(rows.length, count);
    assert.deepEqual(rows.map(row => row.code), ['U+044F', 'U+1F600']);
    assert.deepEqual(query(sourceContext.data)(rows[1]), {
        content: script.source,
        refs: [{ range: [4, 6], className: 'utf-character' }]
    });
});
