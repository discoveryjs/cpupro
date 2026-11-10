import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { createDiagnosticsCollector } from '../diagnostics.js';
import { Dictionary } from '../dictionary.js';
import { createScript, ProfileScriptsMap } from '../preprocessing/scripts.js';
import {
    createFunctionRangeColumns,
    parseScriptSourceRanges,
    writeFunctionRanges,
    type FunctionRange
} from './parse-script-source-ranges.js';
import {
    findFunctionAtLineColumn,
    findFunctionAtPosition,
    getFunctionAtScriptOffset,
    getFunctionAtSourceLineColumn,
    getFunctionEndFromScriptLineColumn,
    getScriptLineColumnFromOffset,
    getScriptOffsetFromLineColumn,
    isScriptTopLevelOffset,
    matchCallFrameIdentity,
    prepareScriptSources,
    terminateParseWorkerPool
} from './script-function-resolution.js';
import { computeScriptSourceMetrics } from './source-text-metrics.js';
import type { CpuProLocation, CpuProScript } from '../types.js';
import { createScriptFixture } from '../../../test/fixtures/scripts.js';
import { evaluateModule } from '../../../test/helpers/evaluate-module.js';

const parseWorkers = vi.hoisted(() => {
    // the pool size is fixed on import from the hardware concurrency: 4 workers of 8 threads
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });

    return [] as ParseWorker[];
});

vi.mock('../workers/index.js', () => ({
    createParseWorker() {
        const worker = new ParseWorker();

        parseWorkers.push(worker);

        return worker;
    }
}));

// Runs the parsing worker module in this thread. As a browser worker, it answers asynchronously,
// delivers a structured clone and ignores messages after termination.
class ParseWorker extends EventTarget {
    // URLs of each request; the order of scripts within a request is not a contract
    requests: string[][] = [];
    terminated = false;
    #onmessage = evaluateModule(new URL('../workers/parse-source-worker.js', import.meta.url), {
        parseScriptSourceRanges,
        createFunctionRangeColumns,
        writeFunctionRanges,
        computeScriptSourceMetrics,
        postMessage: (message: unknown, transfer: ArrayBuffer[]) => {
            const data = structuredClone(message, { transfer });

            this.dispatchEvent(new MessageEvent('message', { data }));
        }
    }, 'onmessage');

    postMessage(payload: { url: string; source: string }[]) {
        if (this.terminated) {
            return;
        }

        this.requests.push(payload.map(script => script.url).sort());
        Promise.resolve().then(() => this.#onmessage({ data: structuredClone(payload) }));
    }

    terminate() {
        this.terminated = true;
    }
}

afterEach(() => {
    terminateParseWorkerPool(true);
    parseWorkers.length = 0;
    vi.useRealTimers();
});

// A script of the given source length without functions
function scriptOfLength(id: number, url: string, length: number) {
    return createScript(id, url, '//'.padEnd(length, 'x'));
}

type RangeStart = 'callFrameStart' | 'start';

// Shortest range with the accepted position, measured from its runtime or source start
function shortestRange(ranges: FunctionRange[], from: RangeStart, accept: (range: FunctionRange) => boolean) {
    let shortest: FunctionRange | null = null;
    let shortestLength = Infinity;

    for (let i = 0; i < ranges.length; i++) {
        const range = ranges[i];

        if (accept(range)) {
            const length = range.end - range[from];

            if (length < shortestLength) {
                shortest = range;
                shortestLength = length;
            }
        }
    }

    return shortest;
}

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
    'function outer(){ function middle(){ function inner(){} } return 1; }',
    'const outer = () => () => 1;',
    'const outer = () => () => 1; function after() {}',
    'class Example { first(){} second(){ return 1; } }',
    '/* first */ function first(){}\n/* second */ function second(){}',
    '/* outer */ function outer() { /* inner */ function inner() {} }',
    'function outer() { /* inner */ function\ninner() {} }',
    'const object = { [(() => "method")()]() { return 1; } };',
    'function outer(value = () => 1) { return value(); }'
])('agrees with an inclusive runtime-range oracle for %s', source => {
    const ranges = parseScriptSourceRanges(source, 'fixture.js', true);

    for (let i = 0; i <= source.length + 1; i++) {
        const startsAt = (range: FunctionRange) => range.callFrameStart === i;
        const contains = (range: FunctionRange) => range.callFrameStart <= i && i <= range.end;
        // a function starting at the offset takes precedence over one ending there
        const expected =
            shortestRange(ranges.ranges, 'callFrameStart', startsAt) ??
            shortestRange(ranges.ranges, 'callFrameStart', contains);
        const preceding = source.slice(0, i).split('\n');
        const line = preceding.length;
        const column = preceding[line - 1].length + Math.max(0, i - source.length);

        assert.equal(findFunctionAtPosition(ranges, i), expected, `offset ${i}`);
        assert.equal(findFunctionAtLineColumn(ranges, line, column), expected, `line/column at ${i}`);
    }
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
        }

        assert.equal(unavailable.sourceMetrics, null);
        assert.equal(unavailable.functionRanges, null);
        assert.deepEqual(empty.sourceMetrics, {
            bytesPerChar: 1,
            byteLength: 0,
            nonLatin1CodeUnits: 0,
            surrogatePairs: 0,
            selfSize: 0
        });
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

test('one worker request prepares the scripts with source, skipping unavailable, empty or prepared ones', async () => {
    const { diagnostics, diagnose } = createDiagnosticsCollector();
    const prepared = createScript(1, 'prepared.js', 'function prepared() {}');

    await prepareScriptSources([prepared]);

    const preparedRanges = prepared.functionRanges;
    const unavailable = createScript(2, 'unavailable.js');
    const empty = createScript(3, 'empty.js', '');
    const invalid = createScript(4, 'invalid.js', 'function broken(\u0100');
    const valid = createScript(5, 'valid.js', 'const run = () => 1;');

    await prepareScriptSources([unavailable, prepared, empty, invalid, valid], diagnose);

    const reported = diagnostics.map(diagnostic => [
        diagnostic.level,
        diagnostic.message,
        diagnostic.details?.scriptId,
        diagnostic.details?.url
    ]);

    assert.equal(parseWorkers.length, 1);
    assert.deepEqual(parseWorkers[0].requests, [['prepared.js'], ['invalid.js', 'valid.js']]);
    assert.equal(prepared.functionRanges, preparedRanges);
    assert.equal(unavailable.functionRanges, null);
    assert.equal(unavailable.sourceMetrics, null);
    assert.deepEqual(empty.functionRanges, []);
    assert.deepEqual(empty.sourceMetrics, {
        bytesPerChar: 1,
        byteLength: 0,
        nonLatin1CodeUnits: 0,
        surrogatePairs: 0,
        selfSize: 0
    });
    assert.equal(invalid.functionRanges, null);
    assert.deepEqual(invalid.sourceMetrics, {
        bytesPerChar: 2,
        byteLength: 34,
        nonLatin1CodeUnits: 1,
        surrogatePairs: 0,
        selfSize: null
    });
    assert.deepEqual(valid.functionRanges, parseScriptSourceRanges(valid.source!, valid.url, true).ranges);
    assert.deepEqual(valid.sourceMetrics, {
        bytesPerChar: 1,
        byteLength: 20,
        nonLatin1CodeUnits: 0,
        surrogatePairs: 0,
        selfSize: 13
    });
    assert.deepEqual(reported, [
        ['error', 'Failed to parse script for function ranges', 4, 'invalid.js']
    ]);
});

test('waits for a script parsed by another call instead of parsing it again', async () => {
    const shared = createScript(1, 'shared.js', 'function shared() {}');
    const other = createScript(2, 'other.js', 'function other() {}');

    const first = prepareScriptSources([shared]);
    await prepareScriptSources([shared, other]);

    assert.equal(shared.functionRanges!.length, 1);
    assert.equal(other.functionRanges!.length, 1);
    assert.deepEqual(parseWorkers.map(worker => worker.requests), [[['shared.js']], [['other.js']]]);

    await first;
});

test('runs at most one worker per two hardware threads and queues further requests', async () => {
    const scripts = [1, 2, 3, 4, 5].map(id => createScript(id, `${id}.js`, `function f${id}() {}`));
    const requests: Promise<void>[] = [];

    for (let i = 0; i < scripts.length; i++) {
        requests.push(prepareScriptSources([scripts[i]]));
    }

    await Promise.all(requests);

    const requested = parseWorkers.flatMap(worker => worker.requests).flat().sort();

    // the fifth request waits for a released worker
    assert.equal(parseWorkers.length, 4);
    assert.deepEqual(requested, ['1.js', '2.js', '3.js', '4.js', '5.js']);

    for (let i = 0; i < scripts.length; i++) {
        assert.equal(scripts[i].functionRanges!.length, 1);
    }
});

test('balances a small payload over idle workers, largest scripts first', async () => {
    await Promise.all([
        prepareScriptSources([scriptOfLength(1, 'warm-1.js', 10)]),
        prepareScriptSources([scriptOfLength(2, 'warm-2.js', 10)]),
        prepareScriptSources([scriptOfLength(3, 'warm-3.js', 10)])
    ]);

    const scripts = [
        scriptOfLength(4, '10.js', 10),
        scriptOfLength(5, '40.js', 40),
        scriptOfLength(6, '20.js', 20),
        scriptOfLength(7, '30.js', 30)
    ];

    await prepareScriptSources(scripts);

    // greedy: 40, 30 and 20 take a worker each, then 10 joins the least loaded one
    const partition = parseWorkers.map(worker => worker.requests[1].join(' ')).sort();

    assert.deepEqual(partition, ['10.js 20.js', '30.js', '40.js']);

    for (let i = 0; i < scripts.length; i++) {
        assert.deepEqual(scripts[i].functionRanges, []);
    }
});

test('terminates an idle worker after 10 seconds and starts a new one for a later request', async () => {
    vi.useFakeTimers();

    await prepareScriptSources([createScript(1, 'first.js', 'function first() {}')]);
    vi.advanceTimersByTime(9_999);

    assert.equal(parseWorkers[0].terminated, false);

    vi.advanceTimersByTime(1);

    assert.equal(parseWorkers[0].terminated, true);

    const later = createScript(2, 'later.js', 'function later() {}');
    const preparing = prepareScriptSources([later]);

    assert.equal(parseWorkers.length, 2);

    await preparing;

    assert.deepEqual(parseWorkers[1].requests, [['later.js']]);
    assert.equal(later.functionRanges!.length, 1);
});

test('terminating the pool stops idle workers at once and busy workers after their request', async () => {
    await Promise.all([
        prepareScriptSources([createScript(1, 'first.js', 'function first() {}')]),
        prepareScriptSources([createScript(2, 'second.js', 'function second() {}')])
    ]);

    const busy = createScript(3, 'busy.js', 'function busy() {}');
    const preparing = prepareScriptSources([busy]);

    terminateParseWorkerPool();

    assert.deepEqual(parseWorkers.map(worker => worker.terminated), [false, true]);

    await preparing;
    // a released worker of a terminated pool stops on a zero idle timeout
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(busy.functionRanges!.length, 1);
    assert.deepEqual(parseWorkers.map(worker => worker.terminated), [true, true]);
});

test('source-map names resolve declaration ranges without changing runtime prefix attribution', async () => {
    const source = 'function outer() {\n  function inner(value: number) { return value; }\n}\nconst after = 1;';
    const script = createScript(1, 'original.ts', source);

    await prepareScriptSources([script]);

    const inner = getFunctionAtSourceLineColumn(script, 1, 11)!;
    const outer = getFunctionAtSourceLineColumn(script, 0, 9)!;

    assert.equal(inner.name, 'inner');
    assert.equal(inner.end, source.indexOf(' }\n') + 2);
    assert.equal(outer.name, 'outer');
    assert.equal(outer.end, source.indexOf('\nconst after'));
    assert.equal(getFunctionAtScriptOffset(script, source.indexOf('inner')), outer);
    assert.equal(getFunctionAtSourceLineColumn(script, 3, 6), null);
    assert.equal(getFunctionAtSourceLineColumn(createScript(2, 'missing.js'), 0, 0), null);
});

test.each([
    '',
    'globalThis.value = 1;',
    '() => 1',
    'function first(){}function second(){ return 1; }',
    'function outer(){ function inner(){} return 1; }',
    'const outer = () => () => 1;',
    'class Example { first(){} second(){ return 1; } }',
    '/* first */ function first(){}\n/* second */ function second(){}',
    '/* outer */ function outer() { /* inner */ function\ninner() {} }',
    'const object = { [(() => "method")()]() { return 1; } };',
    'const object = { [(() => ({ [(() => "nested")()]() {} }))()]() {} };',
    'class Example { @(() => 1)() method() {} }',
    'function outer(value = () => 1) { return value(); }'
])('agrees with an exclusive source-range oracle for %s', async source => {
    const script = createScript(1, 'fixture.ts', source);

    await prepareScriptSources([script]);

    assert.notEqual(script.functionRanges, null);

    for (let i = 0; i <= source.length; i++) {
        const contains = (range: FunctionRange) => range.start <= i && i < range.end;
        const expected = shortestRange(script.functionRanges!, 'start', contains);
        const preceding = source.slice(0, i).split('\n');
        const line = preceding.length - 1;
        const column = preceding[line].length;

        assert.equal(getFunctionAtSourceLineColumn(script, line, column), expected, `offset ${i}`);
    }
});

test('limits source-range refinement to nearby index entries', async () => {
    const source = Array.from({ length: 1_000 }, (_, i) => `function fn${i}() {}`).join('\n');
    const script = createScript(1, 'fixture.js', source);

    await prepareScriptSources([script]);

    const target = script.functionRanges![500];
    let startReads = 0;

    for (let i = 0; i < script.functionRanges!.length; i++) {
        const range = script.functionRanges![i];
        const start = range.start;

        Object.defineProperty(range, 'start', {
            get() {
                startReads++;
                return start;
            }
        });
    }

    assert.equal(getFunctionAtSourceLineColumn(script, 500, 'function '.length), target);
    assert.ok(startReads < 10, `read ${startReads} source starts`);
});

test.each([
    { offset: 0, position: { line: 0, column: 0 } },
    { offset: 8, position: { line: 1, column: 2 } },
    { offset: 12, position: { line: 1, column: 6 } },
    { offset: -1, position: null }
])('converts offset $offset of a script to a zero-based line and column', row => {
    const script = createScript(1, 'fixture.js', 'first\nsecond');

    assert.deepEqual(getScriptLineColumnFromOffset(script, row.offset), row.position);
});

test('a script without source has no line and column positions', () => {
    const unavailable = createScript(1, 'missing.js');

    assert.equal(getScriptLineColumnFromOffset(null, 0), null);
    assert.equal(getScriptLineColumnFromOffset(unavailable, 0), null);
    assert.equal(getScriptOffsetFromLineColumn(null, 0, 0), -1);
    assert.equal(getScriptOffsetFromLineColumn(unavailable, 0, 0), -1);
    assert.equal(getScriptOffsetFromLineColumn(createScript(2, 'fixture.js', 'first\nsecond'), 1, 2), 8);
});

test.each([
    {
        position: 'the call frame of first',
        line: 0,
        column: 14,
        end: 19
    },
    {
        position: 'the class Second',
        line: 1,
        column: 0,
        end: 48
    },
    {
        position: 'the call frame of method',
        line: 1,
        column: 21,
        end: 46
    },
    {
        position: 'the declaration prefix of first',
        line: 0,
        column: 0,
        end: -1
    }
])('finds the end of a function by the V8 position of $position', async row => {
    const script = createScript(1, 'fixture.js', 'function first() {}\nclass Second { method() {} }');

    await prepareScriptSources([script]);

    assert.equal(getFunctionEndFromScriptLineColumn(script, row.line, row.column), row.end);
});

test('a function end is unknown without a parsed source', () => {
    assert.equal(getFunctionEndFromScriptLineColumn(null, 0, 0), -1);
    assert.equal(getFunctionEndFromScriptLineColumn(createScript(1, 'missing.js'), 0, 0), -1);
});

test.each([
    { source: null, errors: 0 },
    { source: '', errors: 0 },
    { source: 'function broken(', errors: 1 }
])('keeps the existing fallback when source is $source', row => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
        const script = createScript(1, 'fixture.js', row.source);
        const dictionary = new Dictionary();

        assert.equal(isScriptTopLevelOffset(script, 5), false);

        const frame = dictionary.resolveLocationCallFrame(script, 5, 0, 5);

        assert.equal(frame.kind, 'function');
        assert.equal(frame.column, 5);
        assert.equal(dictionary.resolveLocationCallFrame(script, 5, 0, 5), frame);
        // a failed parse is reported once for all lookups
        assert.equal(error.mock.calls.length, row.errors);
    } finally {
        error.mockRestore();
        warn.mockRestore();
    }
});

test('classifies only offsets outside of function runtime ranges as top-level', async () => {
    const source =
        'globalThis.value = 1; class Example { field = 2; static other = 3; method() { return 4; } } ' +
        'function known() { return 5; } globalThis.done = 6;';
    const { dictionary, script } = createScriptFixture(source);

    await prepareScriptSources([script]);

    for (const text of ['class Example', 'field = 2', 'static other', 'return 4', 'return 5']) {
        const offset = source.indexOf(text);

        assert.equal(isScriptTopLevelOffset(script, offset), false, text);
        assert.notEqual(dictionary.resolveLocationCallFrame(script, offset, 0, offset).kind, 'script', text);
    }

    for (let i = 0; i < script.functionRanges!.length; i++) {
        const range = script.functionRanges![i];

        assert.equal(isScriptTopLevelOffset(script, range.callFrameStart), false);
        assert.equal(isScriptTopLevelOffset(script, range.end), false);
    }

    for (const offset of [-1, 0.5, NaN, Infinity, source.length + 1]) {
        assert.equal(isScriptTopLevelOffset(script, offset), false, String(offset));
    }

    for (const offset of [0, source.indexOf('1'), source.indexOf('done'), source.length]) {
        assert.equal(isScriptTopLevelOffset(script, offset), true, String(offset));
    }
});

test.each([
    { suffix: '', order: [0, 1] },
    { suffix: '', order: [1, 0] },
    { suffix: '\nfunction known() { return 3; }', order: [0, 1] },
    { suffix: '\nfunction known() { return 3; }', order: [1, 0] }
])('uses one script frame for top-level locations with $suffix, resolved in order $order', async row => {
    const source = 'globalThis.first = 1;\nglobalThis.second = 2;' + row.suffix;
    const dictionary = new Dictionary();
    const scripts = new ProfileScriptsMap(dictionary, [{
        id: 1,
        url: 'fixture.js',
        source,
        lineOffset: 6,
        columnOffset: 225
    }]);
    const script = scripts.get(1)!;
    // positions of 1 and 2
    const positions = [
        { offset: 19, line: 0, column: 19 },
        { offset: 42, line: 1, column: 20 }
    ];
    const locations: CpuProLocation[] = [];

    await prepareScriptSources([script]);

    for (const index of row.order) {
        const { offset, line, column } = positions[index];
        const location = dictionary.resolveLocation(null, script, offset);

        assert.equal(location.callFrame.kind, 'script');
        assert.equal(location.scriptOffset, offset);
        assert.equal(location.line, line);
        assert.equal(location.column, column);
        assert.equal(dictionary.resolveLocation(null, script, -1, line, column), location);
        locations[index] = location;
    }

    const frame = dictionary.callFrames[dictionary.resolveScriptCallFrameIndex(script)];

    assert.equal(locations[0].callFrame, frame);
    assert.equal(locations[1].callFrame, frame);
    assert.equal(dictionary.resolveLocationCallFrame(script, 0, 0, 0), frame);
    assert.deepEqual(
        [frame.name, frame.start, frame.end, frame.line, frame.column],
        ['(script)', 0, source.length, 0, 0]
    );
    assert.equal(frame.location.scriptOffset, 0);
    assert.equal(frame.location.line, 0);
    assert.equal(frame.location.column, 0);
    assert.equal(script.callFrames.length, 1);
});

test('preserves a known frame before considering a parsed top-level fallback', async () => {
    const source = 'globalThis.value = 1;';
    const { dictionary, scripts, script } = createScriptFixture(source);

    await prepareScriptSources([script]);

    const known = dictionary.resolveCallFrame({
        scriptId: 7,
        url: 'fixture.js',
        functionName: 'provided',
        lineNumber: 0,
        columnNumber: 5,
        start: 5,
        end: source.length
    }, scripts);

    assert.equal(dictionary.resolveLocation(null, script, source.indexOf('1')).callFrame, known);
    assert.equal(script.callFrames.length, 1);
});

test.each([false, true])(
    'a declaration prefix resolves to the script, its runtime start to the function (script first: %s)',
    async scriptFirst => {
        const source = 'function first() { return 1; }';
        const dictionary = new Dictionary();
        const script = createScript(1, 'fixture.js', source);

        script.lineOffset = 4;
        script.columnOffset = 50;
        await prepareScriptSources([script]);

        if (scriptFirst) {
            dictionary.resolveScriptCallFrameIndex(script);
        }

        const start = source.indexOf('(');
        const first = dictionary.resolveLocationCallFrame(script, start, 0, start);
        const atOrigin = dictionary.resolveLocationCallFrame(script, 0, 0, 0);
        const scriptFrame = dictionary.callFrames[dictionary.resolveScriptCallFrameIndex(script)];
        const count = dictionary.callFrames.length;
        const identity = Object.freeze({
            script,
            start: 0,
            end: source.length,
            line: 0,
            column: 0
        });

        assert.equal(first.name, 'first');
        assert.notEqual(first, scriptFrame);
        assert.equal(atOrigin, scriptFrame);
        assert.equal(matchCallFrameIdentity(atOrigin, identity), 'exact');
        assert.equal(dictionary.resolveLocationCallFrame(script, start - 1, 0, start - 1), scriptFrame);
        assert.equal(dictionary.resolveLocationCallFrame(script, start, 0, start), first);
        assert.equal(dictionary.resolveLocation(null, script, 0).callFrame, scriptFrame);
        assert.equal(dictionary.resolveLocation(null, script, start).callFrame, first);
        assert.equal(dictionary.callFrames.length, count);
    }
);

test.each([
    'class Base {}',
    'class Derived extends Base {}',
    'const value = class {};',
    '/* before */\nclass Base { method() {} }',
    'class Base {}class Derived extends Base {}',
    'class Base { field = 1; static other = 2; }',
    'class Base { static constructor() {} }'
])('qualifies a default constructor without changing the class source range: %s', async source => {
    const dictionary = new Dictionary();
    const script = createScript(1, 'fixture.js', source);

    await prepareScriptSources([script]);

    const start = source.lastIndexOf('class ');
    const preceding = source.slice(0, start).split('\n');
    const line = preceding.length - 1;
    const column = preceding[line].length;
    const frame = dictionary.resolveLocationCallFrame(script, start, line, column);
    const identity = Object.freeze({
        script,
        start,
        end: start,
        line,
        column
    });
    const frameState = () => [
        frame.start,
        frame.end,
        frame.line,
        frame.column,
        frame.location,
        dictionary.callFrames.length
    ];
    const before = frameState();

    assert.equal(matchCallFrameIdentity(frame, identity), 'default-constructor');
    assert.equal(matchCallFrameIdentity(frame, { ...identity, end: frame.end }), 'exact');
    assert.equal(matchCallFrameIdentity(frame, { ...identity, end: start + 1 }), null);
    assert.equal(matchCallFrameIdentity(frame, { ...identity, column: column + 1 }), null);
    assert.equal(matchCallFrameIdentity(frame, { ...identity, line: line + 1 }), null);
    assert.equal(matchCallFrameIdentity(frame, { ...identity, script: createScript(1, 'fixture.js', source) }), null);
    assert.deepEqual(frameState(), before);
    assert.ok(frame.end > start);
    assert.equal(identity.end, start);
});

test.each([
    'class Explicit { constructor() {} }',
    'class Explicit { "constructor"() {} }',
    'function ordinary() {}',
    'const arrow = () => 1;'
])('does not treat an arbitrary zero-length identity as a default constructor: %s', async source => {
    const script = createScript(1, 'fixture.js', source);
    const dictionary = new Dictionary();

    await prepareScriptSources([script]);

    for (let i = 0; i < script.functionRanges!.length; i++) {
        const range = script.functionRanges![i];
        const start = range.callFrameStart;
        const line = range.callFrameStartLine - 1;
        const column = range.callFrameStartColumn;
        const frame = dictionary.resolveLocationCallFrame(script, start, line, column);
        const identity = {
            script,
            start,
            end: start,
            line,
            column
        };

        assert.equal(matchCallFrameIdentity(frame, identity), null);
    }
});

test.each([
    {
        source: null,
        diagnostics: []
    },
    {
        source: '',
        diagnostics: []
    },
    {
        source: 'class Broken {',
        diagnostics: ['Failed to parse script for function ranges']
    }
])('requires parsed class evidence for a different end when source is $source', async row => {
    const collector = createDiagnosticsCollector();
    const dictionary = new Dictionary();
    const scripts = new ProfileScriptsMap(dictionary, [{ id: 1, url: 'fixture.js', source: row.source! }]);
    const script = scripts.get(1)!;

    await prepareScriptSources([script], collector.diagnose);

    const frame = dictionary.resolveCallFrame({
        scriptId: 1,
        url: script.url,
        functionName: 'Provided',
        lineNumber: 0,
        columnNumber: 0,
        start: 0,
        end: 20
    }, scripts);
    const identity = {
        script,
        start: 0,
        end: 0,
        line: 0,
        column: 0
    };

    assert.equal(matchCallFrameIdentity(frame, identity), null);
    assert.equal(matchCallFrameIdentity(frame, { ...identity, end: 20 }), 'exact');
    assert.equal(frame.end, 20);
    assert.equal(script.callFrames.length, 1);
    assert.deepEqual(collector.diagnostics.map(diagnostic => diagnostic.message), row.diagnostics);
});

test('rejects a script frame and a truncated class frame at the constructor position', async () => {
    const source = 'class Base {}';
    const { dictionary, scripts, script } = createScriptFixture(source);

    await prepareScriptSources([script]);

    const identity = {
        script,
        start: 0,
        end: 0,
        line: 0,
        column: 0
    };
    const scriptFrame = dictionary.callFrames[dictionary.resolveScriptCallFrameIndex(script)];
    const truncated = dictionary.resolveCallFrame({
        scriptId: 7,
        url: script.url,
        functionName: 'Base',
        lineNumber: 0,
        columnNumber: 0,
        start: 0,
        end: source.length - 1
    }, scripts);

    assert.equal(matchCallFrameIdentity(scriptFrame, identity), null);
    assert.equal(matchCallFrameIdentity(truncated, identity), null);
    assert.equal(truncated.end, source.length - 1);
});

test('compares local identity coordinates and rejects unknown or malformed positions', async () => {
    const source = 'class Base {}';
    const dictionary = new Dictionary();
    const scripts = new ProfileScriptsMap(dictionary, [{
        id: 1,
        url: 'fixture.js',
        source,
        lineOffset: 6,
        columnOffset: 225
    }]);
    const script = scripts.get(1)!;

    await prepareScriptSources([script]);

    const frameIndex = dictionary.resolveCallFrameIndex({
        scriptId: 1,
        url: script.url,
        functionName: 'Base',
        lineNumber: 6,
        columnNumber: 225,
        start: 0,
        end: source.length
    }, scripts, true);
    const frame = dictionary.callFrames[frameIndex];
    const identity = {
        script,
        start: 0,
        end: 0,
        line: 0,
        column: 0
    };

    assert.equal(matchCallFrameIdentity(frame, identity), 'default-constructor');
    assert.equal(matchCallFrameIdentity(frame, {
        ...identity,
        line: 6,
        column: 225
    }), null);

    for (const key of ['start', 'end', 'line', 'column'] as const) {
        for (const value of [-1, 0.5, NaN, Infinity]) {
            assert.equal(matchCallFrameIdentity(frame, { ...identity, [key]: value }), null, `${key}: ${value}`);
        }
    }

    assert.equal(matchCallFrameIdentity(frame, { ...identity, script: null }), null);
});

test.each([
    {
        name: 'all equal',
        frame: { lineNumber: 0, columnNumber: 5, start: 5, end: 10 },
        identity: { start: 5, end: 10, line: 0, column: 5 },
        match: 'exact'
    },
    {
        name: 'another start',
        frame: { lineNumber: 0, columnNumber: 5, start: 5, end: 10 },
        identity: { start: 6, end: 10, line: 0, column: 5 },
        match: null
    },
    {
        name: 'another line',
        frame: { lineNumber: 0, columnNumber: 5, start: 5, end: 10 },
        identity: { start: 5, end: 10, line: 1, column: 5 },
        match: null
    },
    {
        name: 'another column',
        frame: { lineNumber: 0, columnNumber: 5, start: 5, end: 10 },
        identity: { start: 5, end: 10, line: 0, column: 6 },
        match: null
    },
    {
        name: 'unknown start',
        frame: { lineNumber: 0, columnNumber: 5, start: -1, end: -1 },
        identity: { start: -1, end: -1, line: 0, column: 5 },
        match: null
    },
    {
        name: 'unknown end',
        frame: { lineNumber: 0, columnNumber: 5, start: 5, end: -1 },
        identity: { start: 5, end: -1, line: 0, column: 5 },
        match: null
    },
    {
        name: 'unknown line',
        frame: { lineNumber: -1, columnNumber: 5, start: 5, end: 10 },
        identity: { start: 5, end: 10, line: -1, column: 5 },
        match: null
    },
    {
        name: 'unknown column',
        frame: { lineNumber: 0, columnNumber: -1, start: 5, end: 10 },
        identity: { start: 5, end: 10, line: 0, column: -1 },
        match: null
    }
])('an exact identity needs every coordinate known and equal: $name', row => {
    const position = row.frame;
    const dictionary = new Dictionary();
    const scripts = new ProfileScriptsMap(dictionary, [{ id: 1, url: 'missing.js', source: null! }]);
    const script: CpuProScript = scripts.get(1)!;
    const frame = dictionary.resolveCallFrame({
        scriptId: 1,
        url: script.url,
        functionName: 'known',
        ...position
    }, scripts);

    // the frame keeps the coordinates as given, unknown ones included
    assert.deepEqual(
        [frame.start, frame.end, frame.line, frame.column],
        [position.start, position.end, position.lineNumber, position.columnNumber]
    );
    assert.equal(matchCallFrameIdentity(frame, { script, ...row.identity }), row.match);
});

test('keeps static initializer identity unresolved without changing class location lookup', async () => {
    const source = 'class Example { static field; static method() {} static last; }';
    const dictionary = new Dictionary();
    const script = createScript(1, 'fixture.js', source);

    await prepareScriptSources([script]);

    const start = source.indexOf('static field');
    const end = source.indexOf('; }');
    const identity = {
        script,
        start,
        end,
        line: 0,
        column: start
    };
    const locationFrame = dictionary.resolveLocationCallFrame(script, start, 0, start);
    const count = dictionary.callFrames.length;

    assert.equal(locationFrame.name, 'Example');
    assert.equal(matchCallFrameIdentity(locationFrame, identity), null);
    assert.equal(dictionary.resolveLocationCallFrame(script, start, 0, start), locationFrame);
    assert.equal(dictionary.callFrames.length, count);
    assert.deepEqual([locationFrame.start, locationFrame.end], [0, source.length]);
});
