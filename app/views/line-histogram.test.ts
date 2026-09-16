import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';
import { resolveScopeProfileLine, resolveScopeViewport } from '../jora/profile.js';
import { lineExtent } from '../jora/viewport.js';
import { validateRange } from '../prepare/computations/coordinates.js';
import { RangeSelection } from '../prepare/computations/range.js';
import usage from './line-histogram.usage.js';
import { setRangeCoverage } from './misc/range-coverage.js';

type Render = (element: unknown, props: unknown, data: unknown, context: unknown) => Promise<void>;

function createLine(origin = 120, total = 60) {
    const profile = { runtime: {}, lines: [] as unknown[] };
    const line = {
        type: 'timeline', profile, breakdowns: [] as unknown[],
        range: new RangeSelection({ name: 'time', unit: 'us' }).view({ start: 0, end: total }, origin)
    };
    profile.lines.push(line);
    Object.assign(profile, { timeline: line });
    line.breakdowns.push({ kind: 'call-stack', line });
    return line;
}

function renderHistogram(props = {}, context = {}) {
    let render: Render = () => assert.fail('View was not registered');
    const source = readFileSync(new URL('./line-histogram.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '');
    runInNewContext(source, {
        resolveScopeProfileLine,
        resolveScopeViewport,
        lineExtent,
        validateRange,
        usage,
        setRangeCoverage,
        discovery: { view: { define(name: string, callback: Render) {
            render = callback;
        } } }
    });
    const styles = new Map();
    const bins = new Float64Array([0, 2, 4]);
    const calls: unknown[][] = [];
    const element = { classList: new Set(), style: { setProperty: (name: string, value: number) => styles.set(name, value) } };
    const completion = Promise.resolve();
    const result = render.call({ render(...args: unknown[]) {
        calls.push(args);
        return completion;
    } },
    element, props, bins, context);
    assert.equal(result, completion);
    assert.equal(calls.length, 1);
    const child = calls[0][1] as { view: string; bins: unknown; presence: unknown; color: unknown };
    assert.equal(child.view, 'bins-histogram');
    return { styles, child, bins, calls };
}

test('renders viewport bins without rebucketing or mutating selection', () => {
    const line = createLine();
    line.range.setRange(10, 20);
    const requested = line.range.selection.ranges;
    const presence = new Uint8Array([1, 1, 1]);
    const { styles, child, bins } = renderHistogram({ presence, color: '#123', height: 30 }, {
        scopeLine: line, scopeViewport: { start: 100, end: 200 }
    });
    assert.equal(styles.get('--range-pad-start'), 0.2);
    assert.ok(Math.abs(styles.get('--range-pad-end') - 0.2) < 1e-12);
    assert.equal(child.bins, bins);
    assert.equal(child.presence, presence);
    assert.equal(child.color, '#123');
    assert.equal(line.range.selection.ranges, requested);
});

test('uses an explicit line or resolves the line from context', () => {
    const line = createLine();
    const other = createLine(100, 100);
    const context = {
        primaryProfile: other.profile, primaryLineType: 'timeline',
        scopeLine: other, scopeBreakdown: other.breakdowns[0], scopeViewport: { start: 100, end: 200 }
    };
    assert.equal(renderHistogram({ line }, context).styles.get('--range-pad-start'), 0.2);
    assert.equal(renderHistogram({ line: 'timeline' }, {
        ...context, scopeProfile: line.profile
    }).styles.get('--range-pad-start'), 0.2);

    for (const scope of [{ scopeLine: line }, {
        primaryProfile: line.profile, primaryLineType: 'timeline'
    }, {
        primaryProfile: other.profile, scopeProfile: line.profile, primaryLineType: 'timeline'
    }]) {
        assert.equal(renderHistogram({}, { ...scope, scopeViewport: context.scopeViewport }).styles.get('--range-pad-start'), 0.2);
    }
});


test('explicit viewport overrides context and local viewport keeps the full width', () => {
    const line = createLine();
    for (const props of [{}, { viewport: { start: 120, end: 180 } }]) {
        const { styles } = renderHistogram(props, { scopeLine: line });
        assert.equal(styles.get('--range-pad-start'), 0);
        assert.equal(styles.get('--range-pad-end'), 0);
    }
    const { styles } = renderHistogram({ viewport: { start: 120, end: 180 } }, {
        scopeLine: line, scopeViewport: { start: 100, end: 200 }
    });
    assert.equal(styles.get('--range-pad-start'), 0);
    assert.equal(styles.get('--range-pad-end'), 0);
});

test('uses the context line for the default viewport independently of the displayed extent', () => {
    const line = createLine();
    const { styles } = renderHistogram({ line }, { scopeLine: createLine(100, 100) });

    assert.equal(styles.get('--range-pad-start'), 0.2);
    assert.equal(styles.get('--range-pad-end'), 0.2);
});

test('accepts explicit coverage without resolving a line', () => {
    const viewport = { start: 100, end: 200 };
    const extent = { start: 110, end: 190 };
    const { styles, child, bins } = renderHistogram({ extent }, { scopeViewport: viewport });

    assert.equal(styles.get('--range-pad-start'), 0.1);
    assert.equal(styles.get('--range-pad-end'), 0.1);
    assert.equal(child.bins, bins);
});


test('validates extent and viewport without normalizing them as one range set', () => {
    const valid = { start: 0, end: 100 };
    for (const invalid of [{ start: 2, end: 1 }, { start: NaN, end: 1 }, { start: 0, end: Infinity }]) {
        assert.throws(() => renderHistogram({ extent: invalid, viewport: valid }), /finite and ordered/);
        const { styles } = renderHistogram({ extent: valid, viewport: invalid });
        assert.equal(styles.get('--range-pad-start'), 0);
        assert.equal(styles.get('--range-pad-end'), 0);
    }
});

test('reports full or missing coverage without changing viewport bins', () => {
    const extent = { start: 120, end: 180 };
    const { styles } = renderHistogram({ extent, viewport: { start: 150, end: 170 } });

    assert.equal(styles.get('--range-pad-start'), 0);
    assert.equal(styles.get('--range-pad-end'), 0);

    for (const viewport of [{ start: 0, end: 100 }, { start: 200, end: 300 }, { start: 150, end: 150 }]) {
        const result = renderHistogram({ extent, viewport });
        assert.equal(result.styles.get('--range-pad-start') + result.styles.get('--range-pad-end'), 1);
        assert.ok([...result.styles.values()].every(Number.isFinite));
    }
});
