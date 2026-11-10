import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveScopeProfileLine, resolveScopeViewport } from '../jora/profile.js';
import { lineExtent, lineZoom, subscribeLineZoom } from '../jora/viewport.js';
import { validateRange } from '../prepare/computations/coordinates.js';
import { createLineFixture } from '../../test/fixtures/profile.js';
import usage from './line-histogram.usage.js';
import { setRangeCoverage } from './misc/range-coverage.js';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';

type Range = { start: number; end: number };
type Line = Awaited<ReturnType<typeof createLineFixture>>['line'];
type Render = (element: unknown, props: unknown, data: unknown, context: unknown) => Promise<void>;
type HistogramConfig = {
    bins: unknown;
    range: Range;
    viewport: Range;
    onInit: undefined | ((api: { setViewport(viewport: Range): void }) => () => void);
};

// A line whose extent is the range from start to end
async function createLine(start: number, end: number) {
    const { line } = await createLineFixture({ origin: start, values: new Uint32Array([end - start]) });

    return line;
}

function renderHistogram(props: object, context: object = {}) {
    let render: Render = () => assert.fail('View was not registered');

    evaluateModule(new URL('./line-histogram.js', import.meta.url), {
        resolveScopeProfileLine,
        resolveScopeViewport,
        lineExtent,
        lineZoom,
        subscribeLineZoom,
        validateRange,
        usage,
        setRangeCoverage,
        discovery: { view: { define(name: string, callback: Render) {
            render = callback;
        } } }
    });

    const data = new Float64Array([0, 2, 4]);
    const classList = new Set<string>();
    const styles = new Map<string, number>();
    const setProperty = (name: string, value: number) => styles.set(name, value);
    const element = { classList, style: { setProperty } };
    const calls: unknown[][] = [];
    const completion = Promise.resolve();
    const result = render.call({ render(...args: unknown[]) {
        calls.push(args);
        return completion;
    } }, element, props, data, context);

    return {
        element,
        data,
        classList,
        styles,
        calls,
        result,
        completion,
        child: calls[0][1] as HistogramConfig
    };
}

// Shares of the displayed range before and after the extent, [start, end]
function coverage(styles: Map<string, number>) {
    return [styles.get('--range-pad-start'), styles.get('--range-pad-end')];
}

test('renders the bins over the viewport with display props unchanged', () => {
    const viewport = { start: 100, end: 200 };
    const context = { scopeViewport: viewport };
    const props = {
        extent: { start: 120, end: 180 },
        presence: new Uint8Array([1, 1, 1]),
        peaks: true,
        color: '#123',
        height: 30,
        max: 8,
        scaleBins: [new Float64Array([1, 2, 3])],
        scaleMax: () => 4,
        binsMax: true,
        scale: 'log'
    };
    const { element, data, calls, result, completion, child } = renderHistogram(props, context);

    assert.equal(result, completion);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], element);
    assert.equal(calls[0][2], data);
    assert.equal(calls[0][3], context);
    assert.equal(child.bins, data);
    assert.equal(child.range, viewport);
    assert.equal(child.viewport, viewport);
    assert.deepEqual({ ...child }, {
        view: 'bins-histogram',
        bins: data,
        range: viewport,
        viewport,
        presence: props.presence,
        peaks: true,
        color: '#123',
        height: 30,
        max: 8,
        scaleBins: props.scaleBins,
        scaleMax: props.scaleMax,
        binsMax: true,
        scale: 'log',
        onInit: undefined
    });
});

test('takes bins from the bins prop over the data', () => {
    const bins = new Float64Array([1, 2]);
    const { child } = renderHistogram({ bins, extent: { start: 0, end: 10 } });

    assert.equal(child.bins, bins);
});

test.each([
    [
        'an explicit line',
        (line: Line, other: Line) => [{ line }, { scopeLine: other }]
    ],
    [
        'a line type of the scope profile',
        (line: Line, other: Line) => [
            { line: 'timeline' },
            { scopeLine: other, primaryProfile: other.profile, scopeProfile: line.profile }
        ]
    ],
    [
        'the scope line',
        (line: Line, other: Line) => [{}, { scopeLine: line, primaryProfile: other.profile }]
    ],
    [
        'the primary line of the scope profile',
        (line: Line, other: Line) => [{}, { primaryProfile: other.profile, scopeProfile: line.profile }]
    ],
    [
        'the primary line of the primary profile',
        (line: Line) => [{}, { primaryProfile: line.profile }]
    ]
])('shows the coverage of the extent of %s', async (_, scope) => {
    const line = await createLine(120, 180);
    const other = await createLine(100, 200);
    const [props, context] = scope(line, other);
    const histogramContext = { ...context, primaryLineType: 'timeline', scopeViewport: { start: 100, end: 200 } };
    const { styles } = renderHistogram(props, histogramContext);

    assert.deepEqual(coverage(styles), [0.2, 0.2]);
});

test.each([
    [
        'an explicit viewport over the context',
        (line: Line) => [
            { viewport: { start: 120, end: 180 } },
            { scopeLine: line, scopeViewport: { start: 100, end: 200 } }
        ],
        { start: 120, end: 180 },
        [0, 0]
    ],
    [
        'the context',
        (line: Line) => [{}, { scopeLine: line, scopeViewport: { start: 100, end: 200 } }],
        { start: 100, end: 200 },
        [0.2, 0.2]
    ],
    [
        'the viewport of the context line rather than of an explicit line',
        (line: Line, other: Line) => [{ line }, { scopeLine: other }],
        { start: 100, end: 200 },
        [0.2, 0.2]
    ],
    [
        'the viewport of the line',
        (line: Line) => [{}, { scopeLine: line }],
        { start: 120, end: 180 },
        [0, 0]
    ],
    [
        'the extent instead of an invalid viewport',
        () => [{ extent: { start: 110, end: 190 }, viewport: { start: 2, end: 1 } }, {}],
        { start: 110, end: 190 },
        [0, 0]
    ],
    [
        'the extent without a viewport and a line',
        () => [{ extent: { start: 110, end: 190 } }, {}],
        { start: 110, end: 190 },
        [0, 0]
    ]
])('takes the viewport of bins from %s', async (_, scope, range, pads) => {
    const line = await createLine(120, 180);
    const other = await createLine(100, 200);
    const [props, context] = scope(line, other);
    const { styles, child } = renderHistogram(props, context);

    assert.deepEqual(child.range, range);
    assert.equal(child.viewport, child.range);
    assert.deepEqual(coverage(styles), pads);
});

test.each([
    ['reversed', { start: 2, end: 1 }],
    ['with a non-finite start', { start: NaN, end: 1 }],
    ['with an infinite end', { start: 0, end: Infinity }]
])('rejects an extent %s', (_, extent) => {
    assert.throws(() => renderHistogram({ extent, viewport: { start: 0, end: 100 } }), /finite and ordered/);
});

test.each([
    ['covered in the middle', { start: 100, end: 200 }, [0.2, 0.2]],
    ['covered wholly', { start: 150, end: 170 }, [0, 0]],
    ['before the extent', { start: 0, end: 100 }, [1, 0]],
    ['after the extent', { start: 200, end: 300 }, [0, 1]],
    ['empty within the extent', { start: 150, end: 150 }, [0, 1]],
    ['empty at the extent start', { start: 120, end: 120 }, [0, 1]]
])('pads a viewport %s by its shares not covered by the extent', (_, viewport, pads) => {
    const { classList, styles } = renderHistogram({ extent: { start: 120, end: 180 }, viewport });

    assert.ok(classList.has('range-coverage'));
    assert.deepEqual(coverage(styles), pads);
});

test('with zoom, displays the line zoom within the viewport of bins and follows it until unsubscribed', async () => {
    const line = await createLine(120, 180);
    const viewport = { start: 100, end: 200 };

    line.zoom.selection.setRange(130, 150);

    const { styles, child } = renderHistogram({ zoom: true }, { scopeLine: line, scopeViewport: viewport });
    const displayed: unknown[] = [];

    assert.equal(child.range, viewport);
    assert.deepEqual(child.viewport, { start: 130, end: 150 });
    assert.deepEqual(coverage(styles), [0, 0]);
    assert.ok(child.onInit);

    const setViewport = (display: Range) => displayed.push([display, ...coverage(styles)]);
    const unsubscribe = child.onInit({ setViewport });

    line.zoom.selection.setRange(110, 130);
    line.zoom.resetRange();
    line.viewport.selection.setRange(140, 160);
    line.viewport.resetRange();
    unsubscribe();
    line.zoom.selection.setRange(110, 130);
    line.viewport.selection.setRange(140, 160);

    // Without a zoom request the line viewport is displayed
    assert.deepEqual(displayed, [
        [{ start: 110, end: 130 }, 0.5, 0],
        [{ start: 120, end: 180 }, 0, 0],
        [{ start: 140, end: 160 }, 0, 0],
        [{ start: 120, end: 180 }, 0, 0]
    ]);
});
