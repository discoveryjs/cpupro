import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
    createFunctionRangeColumns,
    parseScriptSourceRanges,
    readFunctionRanges,
    writeFunctionRanges,
    type FunctionRange,
    type FunctionRanges
} from './parse-script-source-ranges.js';

const jsx = 'const view = () => <div />;';
const typescript = 'const value = (input: number) => input;';
const decorators = 'class Example { @decorate method() {} }';

test.each([
    { url: 'view.jsx', source: jsx, parsed: true },
    { url: 'view.tsx?v=1', source: jsx, parsed: true },
    { url: 'view.tsx', source: typescript, parsed: true },
    { url: 'view.mts', source: typescript, parsed: true },
    { url: 'view.ts', source: decorators, parsed: true },
    { url: 'view.ts', source: jsx, parsed: false },
    { url: 'view.js', source: typescript, parsed: false },
    { url: null, source: jsx, parsed: false }
])('enables syntax plugins by the URL extension: $url parses $source: $parsed', ({ url, source, parsed }) => {
    const result = parseScriptSourceRanges(source, url, true);

    assert.equal(result.parsed, parsed);
});

test('distinguishes an empty function list from failed parsing across structured clone', () => {
    for (const source of ['', 'globalThis.value = 1;']) {
        const ranges = structuredClone(parseScriptSourceRanges(source, 'fixture.js', true));

        assert.equal(ranges.parsed, true);
        assert.equal(ranges.error, undefined);
        assert.deepEqual(ranges.ranges, []);
    }

    const failed = structuredClone(parseScriptSourceRanges('function broken(', 'fixture.js', true));

    assert.equal(failed.parsed, false);
    // the message is the parser's own
    assert.equal(typeof failed.error, 'string');
    assert.deepEqual(failed.ranges, []);
});

test('collects functions next to holes in array literals and patterns', () => {
    const result = parseScriptSourceRanges('const [, first] = [, () => 1, , function second() {}];', 'fixture.js', true);

    assert.equal(result.parsed, true);
    assert.deepEqual(result.ranges.map(range => range.type), ['ArrowFunctionExpression', 'FunctionExpression']);
});

test('source ranges include leading comments and declaration prefixes, runtime ranges start at the V8 call frame', () => {
    const source = '/* outer */\nfunction outer() {\n    /* inner */ function inner() {}\n}';
    const { ranges } = parseScriptSourceRanges(source, 'fixture.js', true);

    assert.deepEqual(ranges.map(({ name, start, startLine, startColumn, callFrameStart, callFrameStartLine, callFrameStartColumn, end, endLine, endColumn }) => ({
        name, start, startLine, startColumn, callFrameStart, callFrameStartLine, callFrameStartColumn, end, endLine, endColumn
    })), [
        { name: 'outer', start: 0, startLine: 1, startColumn: 0, callFrameStart: 26, callFrameStartLine: 2, callFrameStartColumn: 14, end: 68, endLine: 4, endColumn: 1 },
        { name: 'inner', start: 35, startLine: 3, startColumn: 4, callFrameStart: 61, callFrameStartLine: 3, callFrameStartColumn: 30, end: 66, endLine: 3, endColumn: 35 }
    ]);
});

// V8 starts a function call frame at its parameter list, an arrow function and a class at the node start
test.each([
    { source: 'function declared(value) {}', starts: [['FunctionDeclaration', 17]] },
    { source: 'const expression = function named(value) {};', starts: [['FunctionExpression', 33]] },
    { source: 'const arrow = value => value; run();', starts: [['ArrowFunctionExpression', 14]] },
    { source: 'class Example { method(value) {} #hidden() {} }', starts: [['ClassDeclaration', 0], ['ClassMethod', 22], ['ClassPrivateMethod', 40]] },
    { source: 'const object = { method(value) {} };', starts: [['ObjectMethod', 23]] },
    { source: 'const Anonymous = class { run() {} };', starts: [['ClassExpression', 18], ['ClassMethod', 29]] }
])('starts a runtime range at the V8 call frame start: $source', ({ source, starts }) => {
    const { ranges } = parseScriptSourceRanges(source, 'fixture.js', true);

    assert.deepEqual(ranges.map(range => [range.type, range.callFrameStart]), starts);
});

test.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])('restores V8 call frame coordinates across %j', newline => {
    const source = `function${newline}known() { return 1; }`;
    const ranges = parseScriptSourceRanges(source, 'fixture.js', true);
    const range = ranges.ranges[0];

    assert.equal(range.callFrameStart, source.indexOf('('));
    assert.equal(range.callFrameStartLine, 2);
    assert.equal(range.callFrameStartColumn, 5);
});

test.each([
    { origin: 'its identifier', source: 'const named = function own() {};', names: ['own'] },
    { origin: 'its key', source: 'const object = { method() {} };', names: ['method'] },
    { origin: 'its string key', source: 'class Example { "quoted"() {} }', names: ['Example', 'quoted'] },
    { origin: 'a variable', source: 'const arrow = () => 1;', names: ['arrow'] },
    { origin: 'a property key', source: 'const object = { property: () => 1 };', names: ['property'] },
    { origin: 'a string property key', source: 'const object = { "literal": function() {} };', names: ['literal'] },
    { origin: 'a class field', source: 'class Example { handler = () => 1; }', names: ['Example', 'handler'] },
    { origin: 'an assignment target', source: 'assigned = function() {};', names: ['assigned'] },
    { origin: 'a private method', source: 'class Example { #method() {} static #shared() {} get #value() { return 1; } }', names: ['Example', '#method', '#shared', '#value'] },
    { origin: 'a private field', source: 'class Example { #handler = () => 1; }', names: ['Example', '#handler'] },
    { origin: 'nothing', source: 'run(() => 1);', names: [''] }
])('names a function after $origin', ({ source, names }) => {
    const { ranges } = parseScriptSourceRanges(source, 'fixture.js', true);

    assert.deepEqual(ranges.map(range => range.name), names);
});

test.each([
    { source: 'class Base {}', flags: [['Base', true]] },
    { source: 'class Derived extends Base {}', flags: [['Derived', true]] },
    { source: 'const value = class {};', flags: [['value', true]] },
    { source: 'class Base { field = 1; static other = 2; }', flags: [['Base', true]] },
    { source: 'class Base { static constructor() {} }', flags: [['Base', true], ['constructor', false]] },
    { source: 'class Explicit { constructor() {} }', flags: [['Explicit', false], ['constructor', false]] },
    { source: 'class Explicit { "constructor"() {} }', flags: [['Explicit', false], ['constructor', false]] },
    { source: 'function ordinary() {}', flags: [['ordinary', false]] },
    { source: 'const arrow = () => 1;', flags: [['arrow', false]] }
])('marks only a class without its own constructor as having a default constructor: $source', ({ source, flags }) => {
    const { ranges } = parseScriptSourceRanges(source, 'fixture.js', true);

    assert.deepEqual(ranges.map(range => [range.name, range.defaultConstructor]), flags);
});

test('exclusive runtime sizes subtract nested ranges once and retain declaration prefixes in their parent', () => {
    const source = '/* script */ function outer() { function inner() { return () => 1; } return 2; }';
    const { ranges } = parseScriptSourceRanges(source, 'fixture.js', true);

    // outer owns 27..46 (with the prefix "function inner") and 68..80
    assert.deepEqual(ranges.map(range => [range.name, range.selfSize]), [['outer', 31], ['inner', 15], ['', 7]]);
});

// Index of the shortest runtime range containing the offset, -1 when the offset is top-level
function innermostRuntimeRange(ranges: FunctionRange[], offset: number) {
    let innermost = -1;

    for (let index = 0; index < ranges.length; index++) {
        const range = ranges[index];

        if (range.callFrameStart <= offset && offset < range.end) {
            if (innermost === -1 || range.end - range.callFrameStart < ranges[innermost].end - ranges[innermost].callFrameStart) {
                innermost = index;
            }
        }
    }

    return innermost;
}

function indexedRange({ starts, indexes }: FunctionRanges, offset: number) {
    let owner = -1;

    for (let i = 0; i < starts.length && starts[i] <= offset; i++) {
        owner = indexes[i];
    }

    return owner;
}

test.each([
    '',
    'globalThis.value = 1;',
    'function first(){}function second(){}',
    'function outer(){ function first(){}function second(){} return 1; }',
    'const outer = () => () => 1;',
    'const outer = () => () => 1; function after() {}',
    'class Example { constructor() {} method() { return () => 1; } }',
    '/* outer */ function outer() { /* inner */ function inner() {} }',
    'const object = { [(() => "method")()]() { return 1; } };',
    'function outer(value = () => 1) { return value(); }'
])('the index and the exclusive sizes assign every offset to its innermost runtime range: %s', source => {
    const result = parseScriptSourceRanges(source, 'fixture.js', true);
    const selfSizes = new Array(result.ranges.length).fill(0);

    for (let i = 1; i < result.starts.length; i++) {
        assert.ok(result.starts[i - 1] < result.starts[i], `index starts at ${i - 1} and ${i} increase`);
    }

    for (let offset = 0; offset < source.length; offset++) {
        const owner = innermostRuntimeRange(result.ranges, offset);

        assert.equal(indexedRange(result, offset), owner, `offset ${offset}`);

        if (owner !== -1) {
            selfSizes[owner]++;
        }
    }

    assert.deepEqual(result.ranges.map(range => range.selfSize), selfSizes);
});

test('reads function ranges of several scripts from columns as they were written', () => {
    const sources = [
        `
        function declared() {}
        const expression = function() {};
        const arrow = () => 1;
        class Example { method() {} #private() {} }
        const Anonymous = class {};
        const object = { method() {} };
        declare function external(): void;
        enum Choice { First }
        `,
        'function broken(',
        'function first() { return () => 2; }'
    ];
    // the reverse order makes a type code differ from the order of the first occurrences
    const typeNames = [
        'TSEnumDeclaration', 'TSDeclareFunction', 'ObjectMethod', 'ClassPrivateMethod', 'ClassMethod',
        'ClassExpression', 'ClassDeclaration', 'ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'
    ];
    const types = new Map<string, number>();
    const expected: FunctionRange[][] = [];
    let rangeCount = 0;

    for (let i = 0; i < typeNames.length; i++) {
        types.set(typeNames[i], i);
    }

    for (let i = 0; i < sources.length; i++) {
        expected.push(parseScriptSourceRanges(sources[i], 'fixture.ts', true).ranges);
        rangeCount += expected[i].length;
    }

    const columns = createFunctionRangeColumns(rangeCount);
    const typeOf = (range: FunctionRange) => range.type;
    let offset = 0;

    assert.deepEqual(new Set(expected[0].map(typeOf)), new Set(typeNames));

    for (let i = 0; i < expected.length; i++) {
        writeFunctionRanges(columns, offset, expected[i], types);
        offset += expected[i].length;
    }

    assert.equal(types.size, typeNames.length);
    offset = 0;

    for (let i = 0; i < expected.length; i++) {
        const ranges = expected[i];
        const actual = readFunctionRanges(structuredClone(columns), offset, ranges.length, typeNames);

        assert.deepEqual(actual, ranges);

        // read ranges have the shape of parsed ones
        for (let j = 0; j < ranges.length; j++) {
            assert.deepEqual(Object.keys(actual[j]), Object.keys(ranges[j]));
        }

        offset += ranges.length;
    }
});

test('adds types to the list of written ranges in the order of their first occurrence', () => {
    const types = new Map<string, number>();
    const columns = createFunctionRangeColumns(2);

    writeFunctionRanges(columns, 0, parseScriptSourceRanges('() => 1', 'first.js', true).ranges, types);
    writeFunctionRanges(columns, 1, parseScriptSourceRanges('function second() {}', 'second.js', true).ranges, types);

    assert.deepEqual([...types.keys()], ['ArrowFunctionExpression', 'FunctionDeclaration']);
    assert.deepEqual([...columns.type], [0, 1]);
});
