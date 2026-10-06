import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test, vi } from 'vitest';
import { Dictionary } from '../dictionary.js';
import { createScript, OriginalScriptsMap, ProfileScriptsMap } from '../preprocessing/scripts.js';
import { decodeFunctionRangeTypes, parseScriptSourceRanges, type FunctionRanges } from './parse-script-source-ranges.js';
import { findFunctionAtLineColumn, findFunctionAtPosition, getFunctionAtScriptOffset, isScriptTopLevelOffset, matchCallFrameIdentity } from './script-function-resolution.js';
import { computeScriptSourceMetrics } from './source-text-metrics.js';
import { ParseSourceWorkerScriptResult } from '../workers/types.js';

test('indexes a function whose source range starts at zero', () => {
    const source = '() => 1';
    const ranges = parseScriptSourceRanges(source, 'fixture.js', true);

    assert.equal(ranges.ranges.length, 1);
    assert.equal(findFunctionAtPosition(ranges, -1), null);
    assert.equal(findFunctionAtPosition(ranges, 0), ranges.ranges[0]);
    assert.equal(findFunctionAtPosition(ranges, source.length - 1), ranges.ranges[0]);
    assert.equal(findFunctionAtPosition(ranges, source.length), ranges.ranges[0]);
    assert.equal(findFunctionAtPosition(ranges, source.length + 1), null);
});

test('exclusive runtime sizes subtract nested ranges once and retain declaration prefixes in their parent', () => {
    const source = '/* script */ function outer() { function inner() { return () => 1; } return 2; }';
    const result = parseScriptSourceRanges(source, 'fixture.js', true);
    const sourceMetrics = computeScriptSourceMetrics(source, result.ranges);

    const outer = result.ranges.find(range => range.name === 'outer')!;
    const inner = result.ranges.find(range => range.name === 'inner')!;
    const arrow = result.ranges.find(range => range.type === 'ArrowFunctionExpression')!;

    assert.equal(outer.selfSize, outer.end - outer.callFrameStart - (inner.end - inner.callFrameStart));
    assert.equal(inner.selfSize, inner.end - inner.callFrameStart - (arrow.end - arrow.callFrameStart));
    assert.equal(arrow.selfSize, arrow.end - arrow.callFrameStart);
    assert.equal(sourceMetrics!.selfSize, outer.callFrameStart);
    assert.equal(sourceMetrics!.selfSize! + result.ranges.reduce((sum, range) => sum + range.selfSize, 0), source.length);
});

test.each([
    '',
    'globalThis.value = 1;',
    'function first(){}function second(){}',
    'const outer = () => () => 1;',
    'class Example { constructor() {} method() { return () => 1; } }',
    'const object = { [(() => "method")()]() { return 1; } };',
    'function outer(value = () => 1) { return value(); }'
])('exclusive source sizes partition the script: %s', source => {
    const result = parseScriptSourceRanges(source, 'fixture.js', true);
    const sourceMetrics = computeScriptSourceMetrics(source, result.ranges);
    const expected = new Array(result.ranges.length).fill(0);
    let scriptSize = 0;

    for (let offset = 0; offset < source.length; offset++) {
        const owner = result.ranges.filter(range => range.callFrameStart <= offset && offset < range.end)
            .sort((left, right) => left.end - left.callFrameStart - (right.end - right.callFrameStart))[0];

        if (owner) {
            expected[result.ranges.indexOf(owner)]++;
        } else {
            scriptSize++;
        }
    }

    assert.deepEqual(result.ranges.map(range => range.selfSize), expected);
    assert.equal(sourceMetrics!.selfSize, scriptSize);
    assert.equal(scriptSize + expected.reduce((sum, size) => sum + size, 0), source.length);
});

test.each([
    { source: '', bytesPerChar: 1 },
    { source: 'const text = "caf\u00e9";', bytesPerChar: 1 },
    { source: 'const text = "\u0100";', bytesPerChar: 2 },
    { source: 'const text = "\ud83d\ude00";', bytesPerChar: 2 },
    { source: 'const text = "\\u0100";', bytesPerChar: 1 }
])('source storage estimate uses Latin-1 or UTF-16 code units: $source', ({ source, bytesPerChar }) => {
    const sourceMetrics = computeScriptSourceMetrics(source);

    assert.equal(sourceMetrics!.bytesPerChar, bytesPerChar);
    assert.equal(sourceMetrics!.byteLength, source.length * bytesPerChar);
});

test('invalid source retains byte-size metadata without publishing exclusive sizes', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
        const source = 'function broken(\u0100';
        const result = parseScriptSourceRanges(source, 'fixture.js', true);
        const sourceMetrics = computeScriptSourceMetrics(source);

        assert.equal(result.parsed, false);
        assert.deepEqual(sourceMetrics, { bytesPerChar: 2, byteLength: source.length * 2, nonLatin1CodeUnits: 1, surrogatePairs: 0, selfSize: null });
    } finally {
        error.mockRestore();
    }
});

test.each([
    { text: '', nonLatin1CodeUnits: 0, surrogatePairs: 0 },
    { text: 'ASCII\u00e9\u00ff', nonLatin1CodeUnits: 0, surrogatePairs: 0 },
    { text: '\u0100\u044f\ufeff', nonLatin1CodeUnits: 3, surrogatePairs: 0 },
    { text: 'a\ud83d\ude00\ud834\udd1e\u044f', nonLatin1CodeUnits: 5, surrogatePairs: 2 },
    { text: '\ud800x\udfff\ud800\ud800\udc00', nonLatin1CodeUnits: 5, surrogatePairs: 1 },
    { text: '\\u0100\\ud83d\\ude00', nonLatin1CodeUnits: 0, surrogatePairs: 0 }
])('counts source code units and surrogate pairs without decoding escapes: $text', ({ text, nonLatin1CodeUnits, surrogatePairs }) => {
    const source = `/*${text}*/`;
    const result = structuredClone(parseScriptSourceRanges(source, 'fixture.js', true));
    const sourceMetrics = computeScriptSourceMetrics(source, result.ranges);

    assert.equal(sourceMetrics!.nonLatin1CodeUnits, nonLatin1CodeUnits);
    assert.equal(sourceMetrics!.surrogatePairs, surrogatePairs);
    assert.equal(source.length - surrogatePairs, Array.from(source).length);
    assert.equal(sourceMetrics!.byteLength, source.length * (nonLatin1CodeUnits ? 2 : 1));
});

test('script metadata distinguishes unavailable, empty, invalid and parsed source', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
        const unavailable = createScript(1, 'missing.js');
        const empty = createScript(2, 'empty.js', '');
        const invalid = createScript(3, 'invalid.js', 'function broken(\u0100');
        const valid = createScript(4, 'valid.js', 'const run = () => 1;');

        for (const script of [unavailable, empty, invalid, valid]) {
            getFunctionAtScriptOffset(script, 0);
            script.sourceMetrics = computeScriptSourceMetrics(script.source!, script.functionRanges);
        }

        assert.equal(unavailable.sourceMetrics, null);
        assert.equal(unavailable.functionRanges, null);
        assert.deepEqual(empty.sourceMetrics, { bytesPerChar: 1, byteLength: 0, nonLatin1CodeUnits: 0, surrogatePairs: 0, selfSize: 0 });
        assert.deepEqual(empty.functionRanges, []);
        assert.equal(invalid.sourceMetrics!.bytesPerChar, 2);
        assert.equal(invalid.sourceMetrics!.selfSize, null);
        assert.equal(invalid.functionRanges, null);
        assert.equal(valid.functionRanges!.length, 1);
        assert.equal(valid.sourceMetrics!.selfSize! + valid.functionRanges![0].selfSize, valid.source!.length);
    } finally {
        warn.mockRestore();
        error.mockRestore();
    }
});

test.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])('restores V8 call frame coordinates across %j', newline => {
    const source = `function${newline}known() { return 1; }`;
    const ranges = parseScriptSourceRanges(source, 'fixture.js', true);
    const range = ranges.ranges[0];

    assert.equal(range.callFrameStart, source.indexOf('('));
    assert.equal(range.callFrameStartLine, 2);
    assert.equal(range.callFrameStartColumn, 5);
});

test('prefers a function starting at a shared boundary to the preceding function end', () => {
    const source = 'class First{}class Second{ method() {} }';
    const ranges = parseScriptSourceRanges(source, 'fixture.js', true);
    const [first, second] = ranges.ranges;

    assert.equal(first.end, second.callFrameStart);
    assert.equal(findFunctionAtPosition(ranges, second.callFrameStart), second);
    assert.equal(findFunctionAtLineColumn(ranges, second.callFrameStartLine, second.callFrameStartColumn), second);
});

test.each([
    '() => 1',
    'function first(){}function second(){ return 1; }',
    'function outer(){ function inner(){} return 1; }',
    'const outer = () => () => 1;',
    'class Example { first(){} second(){ return 1; } }',
    '/* first */ function first(){}\n/* second */ function second(){}',
    'function outer() { /* inner */ function\ninner() {} }',
    'const object = { [(() => "method")()]() { return 1; } };',
    'function outer(value = () => 1) { return value(); }'
])('agrees with an inclusive runtime-range oracle for %s', source => {
    const ranges = parseScriptSourceRanges(source, 'fixture.js', true);

    for (let offset = 0; offset <= source.length + 1; offset++) {
        const candidates = ranges.ranges.filter(range => range.callFrameStart <= offset && offset <= range.end);
        const starting = candidates.filter(range => range.callFrameStart === offset);
        const expected = (starting.length ? starting : candidates)
            .sort((left, right) => left.end - left.callFrameStart - (right.end - right.callFrameStart))[0] || null;
        const preceding = source.slice(0, offset).split('\n');
        const line = preceding.length;
        const column = preceding[line - 1].length + Math.max(0, offset - source.length);

        assert.equal(findFunctionAtPosition(ranges, offset), expected, `offset ${offset}`);
        assert.equal(findFunctionAtLineColumn(ranges, line, column), expected, `line/column at ${offset}`);
    }
});

test('attributes declaration prefixes and leading comments to the outer runtime range', () => {
    const source = '/* outer */ function outer() { /* inner */ function inner() {} }';
    const ranges = parseScriptSourceRanges(source, 'fixture.js', true);
    const outer = ranges.ranges.find(range => range.name === 'outer')!;
    const inner = ranges.ranges.find(range => range.name === 'inner')!;

    assert.equal(outer.start, 0);
    assert.equal(inner.start, source.indexOf('/* inner */'));
    assert.equal(findFunctionAtPosition(ranges, 0), null);
    assert.equal(findFunctionAtPosition(ranges, outer.callFrameStart - 1), null);
    assert.equal(findFunctionAtPosition(ranges, outer.callFrameStart), outer);
    assert.equal(findFunctionAtPosition(ranges, inner.start), outer);
    assert.equal(findFunctionAtPosition(ranges, inner.callFrameStart - 1), outer);
    assert.equal(findFunctionAtPosition(ranges, inner.callFrameStart), inner);
});

test.each([
    { suffix: '', reverse: false },
    { suffix: '', reverse: true },
    { suffix: '\nfunction known() { return 3; }', reverse: false },
    { suffix: '\nfunction known() { return 3; }', reverse: true }
])('uses one script frame for top-level locations with $suffix, reverse=$reverse', ({ suffix, reverse }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
        const source = 'globalThis.first = 1;\nglobalThis.second = 2;' + suffix;
        const dictionary = new Dictionary();
        const scripts = new ProfileScriptsMap(dictionary, new OriginalScriptsMap(dictionary), [{
            id: 1, url: 'fixture.js', source, lineOffset: 6, columnOffset: 225
        }]);
        const script = scripts.get(1)!;
        const offsets = [source.indexOf('1'), source.indexOf('2')];
        const positions = offsets.map(offset => {
            const line = source.slice(0, offset).split('\n');
            return { offset, line: line.length - 1, column: line[line.length - 1].length };
        });
        const locations = (reverse ? positions.slice().reverse() : positions).map(position => {
            const location = dictionary.resolveLocation(null, script, position.offset);

            assert.equal(location.callFrame.kind, 'script');
            assert.equal(location.scriptOffset, position.offset);
            assert.equal(location.line, position.line);
            assert.equal(location.column, position.column);
            assert.equal(dictionary.resolveLocation(null, script, -1, position.line, position.column), location);

            return location;
        });
        const frame = dictionary.callFrames[dictionary.resolveScriptCallFrameIndex(script)];

        assert.equal(locations[0].callFrame, frame);
        assert.equal(locations[1].callFrame, frame);
        assert.equal(dictionary.resolveLocationCallFrame(script, 0, 0, 0), frame);
        assert.deepEqual([frame.name, frame.start, frame.end, frame.line, frame.column], ['(script)', 0, source.length, 0, 0]);
        assert.equal(frame.location.scriptOffset, 0);
        assert.equal(frame.location.line, 0);
        assert.equal(frame.location.column, 0);
        assert.equal(script.callFrames.length, 1);

        if (suffix) {
            const inside = dictionary.resolveLocation(null, script, source.indexOf('return 3'));
            assert.equal(inside.callFrame.name, 'known');
            assert.notEqual(inside.callFrame, frame);
        }
    } finally {
        warn.mockRestore();
    }
});

test('distinguishes an empty function list from failed parsing across structured clone', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
        for (const source of ['', 'globalThis.value = 1;']) {
            const ranges = structuredClone(parseScriptSourceRanges(source, 'fixture.js', true));
            assert.equal(ranges.parsed, true);
            assert.deepEqual(ranges.ranges, []);
        }

        const failed = structuredClone(parseScriptSourceRanges('function broken(', 'fixture.js', true));
        assert.equal(failed.parsed, false);
        assert.deepEqual(failed.ranges, []);
        assert.equal(error.mock.calls.length, 1);
    } finally {
        error.mockRestore();
    }
});

test('restores all function range types in place after worker transfer', () => {
    const source = `
        function declared() {}
        const expression = function() {};
        const arrow = () => 1;
        class Example { method() {} #private() {} }
        const Anonymous = class {};
        const object = { method() {} };
        declare function external(): void;
        enum Choice { First }
    `;
    const expected = parseScriptSourceRanges(source, 'fixture.ts', true);
    assert.equal(new Set(expected.ranges.map(range => range.type)).size, 10);
    const types = [...new Set(expected.ranges.map(range => range.type))].reverse();
    const typeIndexes = new Map(types.map((type, index) => [type, index]));
    const input: FunctionRanges<number> = {
        ...parseScriptSourceRanges(source, 'fixture.ts', true),
        ranges: expected.ranges.map(range => ({ ...range, type: typeIndexes.get(range.type)! }))
    };
    const buffers = [(input.starts as unknown as Uint32Array).buffer, (input.indexes as unknown as Int32Array).buffer];
    const message = structuredClone({ ranges: input, types }, { transfer: buffers });
    const received = message.ranges;
    const rangeObjects = received.ranges.slice();
    const starts = received.starts;
    const indexes = received.indexes;

    assert.ok(received.ranges.every(range => Number.isInteger(range.type) && range.type >= 0));
    assert.ok(buffers.every(buffer => buffer.byteLength === 0));

    const decoded = decodeFunctionRangeTypes(received, message.types);

    assert.equal(decoded, received);
    assert.equal(decoded.ranges, received.ranges);
    decoded.ranges.forEach((range, index) => assert.equal(range, rangeObjects[index]));
    assert.equal(decoded.starts, starts);
    assert.equal(decoded.indexes, indexes);
    assert.deepEqual(decoded, expected);
    for (let offset = 0; offset <= source.length; offset++) {
        assert.deepEqual(findFunctionAtPosition(decoded, offset), findFunctionAtPosition(expected, offset));
    }
});

test('the parsing worker transfers source metrics with type-encoded function ranges', async () => {
    const sources = ['function outer() { return () => "\u0100"; }', '', 'const text = "caf\u00e9";'];
    const messages: { scripts: ParseSourceWorkerScriptResult[]; types: string[] }[] = [];
    const handler = runInNewContext(
        readFileSync(new URL('../workers/parse-source-worker.js', import.meta.url), 'utf8')
            .replace(/^(import .*;\n)+/, '') + '\nonmessage;',
        {
            parseScriptSourceRanges,
            computeScriptSourceMetrics,
            postMessage(message: typeof messages[number], transfer: ArrayBuffer[]) {
                messages.push(structuredClone(message, { transfer }));
            }
        }
    );

    await handler({ data: sources.map((source, id) => ({ id, source, url: 'fixture.js' })) });
    assert.equal(messages.length, 1);

    for (let index = 0; index < sources.length; index++) {
        const { ranges, sourceMetrics } = messages[0].scripts[index];
        const result = decodeFunctionRangeTypes(ranges, messages[0].types);
        assert.deepEqual(result, parseScriptSourceRanges(sources[index], 'fixture.js', true));
        assert.equal(sourceMetrics.selfSize! + result.ranges.reduce((sum, range) => sum + range.selfSize, 0), sources[index].length);
    }
});

test.each([true, false])('restores type encoding for an empty result, parsed: %s', parsed => {
    const starts = new Uint32Array([]);
    const indexes = new Int32Array([]);
    const input: FunctionRanges<number> = { parsed, ranges: [], starts, indexes };
    assert.equal(decodeFunctionRangeTypes(input, []), input);
    assert.deepEqual(input, { parsed, ranges: [], starts, indexes });
});

test('decodes multiple scripts against a shared message dictionary without reusing codes across messages', () => {
    const expected = [
        parseScriptSourceRanges('() => 1', 'first.js', true),
        parseScriptSourceRanges('() => 2', 'second.js', true),
        parseScriptSourceRanges('function third() {}', 'third.js', true)
    ];
    const firstMessage = structuredClone({
        types: ['ArrowFunctionExpression'],
        scripts: expected.slice(0, 2).map(entry => ({
            ...entry,
            ranges: entry.ranges.map(range => ({ ...range, type: 0 }))
        }))
    });
    const secondMessage = structuredClone({
        types: ['FunctionDeclaration'],
        scripts: [{ ...expected[2], ranges: expected[2].ranges.map(range => ({ ...range, type: 0 })) }]
    });

    const first = firstMessage.scripts.map(entry => decodeFunctionRangeTypes(entry, firstMessage.types));
    const second = decodeFunctionRangeTypes(secondMessage.scripts[0], secondMessage.types);

    assert.deepEqual([...first, second], expected);
    assert.deepEqual(firstMessage.types, ['ArrowFunctionExpression']);
    assert.deepEqual(secondMessage.types, ['FunctionDeclaration']);
});

test.each([null, '', 'function broken('])('keeps the existing fallback when source is %j', source => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
        const script = createScript(1, 'fixture.js', source);
        const dictionary = new Dictionary();

        assert.equal(isScriptTopLevelOffset(script, 5), false);
        const frame = dictionary.resolveLocationCallFrame(script, 5, 0, 5);

        assert.equal(frame.kind, 'function');
        assert.equal(frame.column, 5);
        assert.equal(dictionary.resolveLocationCallFrame(script, 5, 0, 5), frame);
        assert.equal(error.mock.calls.length, source ? 1 : 0);
    } finally {
        error.mockRestore();
        warn.mockRestore();
    }
});

test('does not classify class bodies or function boundaries as top-level', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
        const source = 'globalThis.value = 1; class Example { field = 2; static other = 3; method() { return 4; } } function known() { return 5; }';
        const script = createScript(1, 'fixture.js', source);
        const dictionary = new Dictionary();
        const ranges = parseScriptSourceRanges(source, 'fixture.js', true);

        for (const text of ['class Example', 'field = 2', 'static other', 'return 4', 'return 5']) {
            const offset = source.indexOf(text);
            assert.equal(isScriptTopLevelOffset(script, offset), false);
            assert.notEqual(dictionary.resolveLocationCallFrame(script, offset, 0, offset).kind, 'script');
        }
        for (const range of ranges.ranges) {
            assert.equal(isScriptTopLevelOffset(script, range.callFrameStart), false);
            assert.equal(isScriptTopLevelOffset(script, range.end), false);
        }
        for (const offset of [-1, 0.5, NaN, Infinity, source.length + 1]) {
            assert.equal(isScriptTopLevelOffset(script, offset), false);
        }
        assert.equal(isScriptTopLevelOffset(script, source.indexOf('1')), true);
    } finally {
        warn.mockRestore();
    }
});

test('preserves a known frame before considering a parsed top-level fallback', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
        const source = 'globalThis.value = 1;';
        const dictionary = new Dictionary();
        const scripts = new ProfileScriptsMap(dictionary, new OriginalScriptsMap(dictionary), [{ id: 1, url: 'fixture.js', source }]);
        const script = scripts.get(1)!;
        const known = dictionary.resolveCallFrame({
            scriptId: 1, url: 'fixture.js', functionName: 'provided', lineNumber: 0, columnNumber: 5, start: 5, end: source.length
        }, scripts);

        assert.equal(dictionary.resolveLocation(null, script, source.indexOf('1')).callFrame, known);
        assert.equal(script.callFrames.length, 1);
    } finally {
        warn.mockRestore();
    }
});

test.each([
    'class Base {}',
    'class Derived extends Base {}',
    'const value = class {};',
    '/* before */\nclass Base { method() {} }',
    'class Base {}class Derived extends Base {}',
    'class Base { field = 1; static other = 2; }',
    'class Base { static constructor() {} }'
])('qualifies a default constructor without changing the class source range: %s', source => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
        const dictionary = new Dictionary();
        const script = createScript(1, 'fixture.js', source);
        const start = source.lastIndexOf('class ');
        const preceding = source.slice(0, start).split('\n');
        const line = preceding.length - 1;
        const column = preceding[line].length;
        const frame = dictionary.resolveLocationCallFrame(script, start, line, column);
        const identity = Object.freeze({ script, start, end: start, line, column });
        const before = [frame.start, frame.end, frame.line, frame.column, frame.location, dictionary.callFrames.length];

        assert.equal(matchCallFrameIdentity(frame, identity), 'default-constructor');
        assert.equal(matchCallFrameIdentity(frame, { ...identity, end: frame.end }), 'exact');
        assert.equal(matchCallFrameIdentity(frame, { ...identity, end: start + 1 }), null);
        assert.equal(matchCallFrameIdentity(frame, { ...identity, column: column + 1 }), null);
        assert.equal(matchCallFrameIdentity(frame, { ...identity, line: line + 1 }), null);
        assert.equal(matchCallFrameIdentity(frame, { ...identity, script: createScript(1, 'fixture.js', source) }), null);
        assert.deepEqual([frame.start, frame.end, frame.line, frame.column, frame.location, dictionary.callFrames.length], before);
        assert.ok(frame.end > start);
        assert.equal(identity.end, start);

        const ranges = structuredClone(parseScriptSourceRanges(source, 'fixture.js', true));
        const range = ranges.ranges.find(range => range.callFrameStart === start)!;
        assert.equal(range.defaultConstructor, true);
    } finally {
        warn.mockRestore();
    }
});

test.each([
    'class Explicit { constructor() {} }',
    'class Explicit { "constructor"() {} }',
    'function ordinary() {}',
    'const arrow = () => 1;'
])('does not treat an arbitrary zero-length identity as a default constructor: %s', source => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
        const script = createScript(1, 'fixture.js', source);
        const ranges = parseScriptSourceRanges(source, 'fixture.js', true);
        const dictionary = new Dictionary();

        for (const range of ranges.ranges) {
            assert.equal(range.defaultConstructor, false);
            const start = range.callFrameStart;
            const line = range.callFrameStartLine - 1;
            const column = range.callFrameStartColumn;
            const frame = dictionary.resolveLocationCallFrame(script, start, line, column);

            assert.equal(matchCallFrameIdentity(frame, { script, start, end: start, line, column }), null);
        }
    } finally {
        warn.mockRestore();
    }
});

test.each([null, '', 'class Broken {'])('requires parsed class evidence for a different end when source is %j', source => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
        const dictionary = new Dictionary();
        const scripts = new ProfileScriptsMap(dictionary, new OriginalScriptsMap(dictionary), [{ id: 1, url: 'fixture.js', source: source! }]);
        const script = scripts.get(1)!;
        const frame = dictionary.resolveCallFrame({
            scriptId: 1,
            url: script.url,
            functionName: 'Provided',
            lineNumber: 0,
            columnNumber: 0,
            start: 0,
            end: 20
        }, scripts);
        const identity = { script, start: 0, end: 0, line: 0, column: 0 };

        assert.equal(matchCallFrameIdentity(frame, identity), null);
        assert.equal(matchCallFrameIdentity(frame, { ...identity, end: 20 }), 'exact');
        assert.equal(frame.end, 20);
        assert.equal(script.callFrames.length, 1);
        assert.equal(error.mock.calls.length, source ? 1 : 0);
    } finally {
        error.mockRestore();
        warn.mockRestore();
    }
});

test('rejects a script frame and a truncated class frame at the constructor position', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
        const source = 'class Base {}';
        const dictionary = new Dictionary();
        const scripts = new ProfileScriptsMap(dictionary, new OriginalScriptsMap(dictionary), [{ id: 1, url: 'fixture.js', source }]);
        const script = scripts.get(1)!;
        const identity = { script, start: 0, end: 0, line: 0, column: 0 };
        const scriptFrame = dictionary.callFrames[dictionary.resolveScriptCallFrameIndex(script)];
        const truncated = dictionary.resolveCallFrame({
            scriptId: 1, url: script.url, functionName: 'Base', lineNumber: 0, columnNumber: 0, start: 0, end: source.length - 1
        }, scripts);

        assert.equal(matchCallFrameIdentity(scriptFrame, identity), null);
        assert.equal(matchCallFrameIdentity(truncated, identity), null);
        assert.equal(truncated.end, source.length - 1);
    } finally {
        warn.mockRestore();
    }
});

test('compares local identity coordinates and rejects unknown or malformed positions', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
        const source = 'class Base {}';
        const dictionary = new Dictionary();
        const scripts = new ProfileScriptsMap(dictionary, new OriginalScriptsMap(dictionary), [{
            id: 1, url: 'fixture.js', source, lineOffset: 6, columnOffset: 225
        }]);
        const script = scripts.get(1)!;
        const frame = dictionary.callFrames[dictionary.resolveCallFrameIndex({
            scriptId: 1, url: script.url, functionName: 'Base', lineNumber: 6, columnNumber: 225, start: 0, end: source.length
        }, scripts, true)];
        const identity = { script, start: 0, end: 0, line: 0, column: 0 };

        assert.equal(matchCallFrameIdentity(frame, identity), 'default-constructor');
        assert.equal(matchCallFrameIdentity(frame, { ...identity, line: 6, column: 225 }), null);

        for (const key of ['start', 'end', 'line', 'column'] as const) {
            for (const value of [-1, 0.5, NaN, Infinity]) {
                assert.equal(matchCallFrameIdentity(frame, { ...identity, [key]: value }), null);
            }
        }
        assert.equal(matchCallFrameIdentity(frame, { ...identity, script: null }), null);
    } finally {
        warn.mockRestore();
    }
});

test.each([false, true])('resolves a declaration prefix to script and its runtime start to the function, script first: %s', scriptFirst => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
        const source = 'function first() { return 1; }';
        const dictionary = new Dictionary();
        const script = createScript(1, 'fixture.js', source);
        script.lineOffset = 4;
        script.columnOffset = 50;

        if (scriptFirst) {
            dictionary.resolveScriptCallFrameIndex(script);
        }

        const start = source.indexOf('(');
        const first = dictionary.resolveLocationCallFrame(script, start, 0, start);
        const atOrigin = dictionary.resolveLocationCallFrame(script, 0, 0, 0);
        const scriptFrame = dictionary.callFrames[dictionary.resolveScriptCallFrameIndex(script)];
        const count = dictionary.callFrames.length;
        const identity = Object.freeze({ script, start: 0, end: source.length, line: 0, column: 0 });

        assert.equal(first.name, 'first');
        assert.notEqual(first, scriptFrame);
        assert.equal(atOrigin, scriptFrame);
        assert.equal(matchCallFrameIdentity(atOrigin, identity), 'exact');
        assert.equal(dictionary.resolveLocationCallFrame(script, start - 1, 0, start - 1), scriptFrame);
        assert.equal(dictionary.resolveLocationCallFrame(script, start, 0, start), first);
        assert.equal(dictionary.resolveLocation(null, script, 0).callFrame, scriptFrame);
        assert.equal(dictionary.resolveLocation(null, script, start).callFrame, first);
        assert.equal(dictionary.callFrames.length, count);
    } finally {
        warn.mockRestore();
    }
});

test('keeps static initializer identity unresolved without changing class location lookup', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
        const source = 'class Example { static field; static method() {} static last; }';
        const dictionary = new Dictionary();
        const script = createScript(1, 'fixture.js', source);
        const start = source.indexOf('static field');
        const end = source.indexOf('; }');
        const identity = { script, start, end, line: 0, column: start };
        const locationFrame = dictionary.resolveLocationCallFrame(script, start, 0, start);
        const count = dictionary.callFrames.length;

        assert.equal(locationFrame.name, 'Example');
        assert.equal(matchCallFrameIdentity(locationFrame, identity), null);
        assert.equal(dictionary.resolveLocationCallFrame(script, start, 0, start), locationFrame);
        assert.equal(dictionary.callFrames.length, count);
        assert.deepEqual([locationFrame.start, locationFrame.end], [0, source.length]);
    } finally {
        warn.mockRestore();
    }
});
