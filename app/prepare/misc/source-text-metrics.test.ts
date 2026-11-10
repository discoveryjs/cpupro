import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseScriptSourceRanges } from './parse-script-source-ranges.js';
import { computeScriptSourceMetrics } from './source-text-metrics.js';

test.each([
    {
        text: '',
        bytesPerChar: 1,
        byteLength: 0,
        nonLatin1CodeUnits: 0,
        surrogatePairs: 0
    },
    {
        text: 'ASCII\u00e9\u00ff',
        bytesPerChar: 1,
        byteLength: 7,
        nonLatin1CodeUnits: 0,
        surrogatePairs: 0
    },
    {
        text: '\u00ff\u0100',
        bytesPerChar: 2,
        byteLength: 4,
        nonLatin1CodeUnits: 1,
        surrogatePairs: 0
    },
    {
        text: 'a\ud83d\ude00\ud834\udd1e\u044f',
        bytesPerChar: 2,
        byteLength: 12,
        nonLatin1CodeUnits: 5,
        surrogatePairs: 2
    },
    {
        text: '\ud800\udfff',
        bytesPerChar: 2,
        byteLength: 4,
        nonLatin1CodeUnits: 2,
        surrogatePairs: 1
    },
    {
        text: '\udbff\udc00',
        bytesPerChar: 2,
        byteLength: 4,
        nonLatin1CodeUnits: 2,
        surrogatePairs: 1
    },
    {
        text: '\udc00\ud800',
        bytesPerChar: 2,
        byteLength: 4,
        nonLatin1CodeUnits: 2,
        surrogatePairs: 0
    },
    {
        text: '\ud800x\udfff\ud800\ud800\udc00',
        bytesPerChar: 2,
        byteLength: 12,
        nonLatin1CodeUnits: 5,
        surrogatePairs: 1
    },
    {
        text: '\\u0100\\ud83d\\ude00',
        bytesPerChar: 1,
        byteLength: 18,
        nonLatin1CodeUnits: 0,
        surrogatePairs: 0
    }
])('stores $text in Latin-1 or UTF-16 code units without decoding escapes', row => {
    const { text, ...metrics } = row;

    assert.deepEqual(computeScriptSourceMetrics(text), { ...metrics, selfSize: null });
});

test('a script without source has no metrics', () => {
    assert.equal(computeScriptSourceMetrics(null), null);
    assert.equal(computeScriptSourceMetrics(null, []), null);
});

test('the script exclusive size is the source that function ranges leave', () => {
    const source = '/* script */ function outer() { function inner() { return () => 1; } return 2; }';
    const { ranges } = parseScriptSourceRanges(source, 'fixture.js', true);

    // the prefix "/* script */ function outer" before the call frame of outer
    assert.equal(computeScriptSourceMetrics(source, ranges)!.selfSize, 27);
    assert.equal(computeScriptSourceMetrics(source, [])!.selfSize, source.length);
    assert.equal(computeScriptSourceMetrics(source, null)!.selfSize, null);
});
