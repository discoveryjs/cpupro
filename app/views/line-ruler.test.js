import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createRulerHarness } from '../../test/helpers/ruler.js';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import { resolveScopeProfileLine } from '../jora/profile.js';
import { formatMicrosecondsTime } from '../prepare/misc/time-utils.js';
import { createState, rangeToSegments } from './ruler-range.js';
import { binsPerColumn } from './bins-histogram/index.js';
import { lineViewport, lineViewportBounds } from '../jora/viewport.js';
import { RangeSelection } from '../prepare/computations/range.js';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';

let renderLineRuler;
let viewOptions;
evaluateModule(new URL('./line-ruler.js', import.meta.url), {
    discovery: { view: { define(name, render, options) {
        assert.equal(name, 'line-ruler');
        renderLineRuler = render;
        viewOptions = options;
    } } },
    require: () => ({
        resolveScopeProfileLine, lineViewport, lineViewportBounds, formatMicrosecondsTime,
        createState, rangeToSegments, binsPerColumn
    })
});

test('forwards resolved props and callbacks without a container or a second selection owner', async () => {
    const { profile } = await createProfileFixture();
    const harness = createRulerHarness();
    const data = { profile };
    const context = { primaryProfile: profile, primaryLineType: 'timeline' };
    assert.equal(viewOptions.tag, false);
    for (const [line, range, expected] of [
        [undefined, 1_000_000, formatMicrosecondsTime(100_000, 1_000_000)],
        ['memline', 100_000, '10Kb'],
        [profile.memline, 1_000_000, '0.1Mb'],
        [undefined, { start: 1000, end: 2000 }, formatMicrosecondsTime(1100, 1000)],
        [undefined, [1000, 2000], formatMicrosecondsTime(1100, 1000)]
    ]) {
        const element = harness.createElement('ruler');
        const rangeManager = profile.timeline.range;
        let initialized = 0;
        const onInit = () => {
            initialized++;
        };
        const onChange = () => {};
        const details = { view: 'struct' };
        renderLineRuler.call({ render(target, config, input, scope) {
            assert.equal(target, element);
            assert.equal(config.view, 'ruler');
            assert.equal(config.range, range);
            assert.equal(config.bounds, null);
            assert.equal(config.onRangeChange, false);
            assert.equal(config.rangeManager, undefined);
            assert.equal(config.multiple, true);
            assert.equal(config.selection, rangeManager.ranges);
            assert.equal(config.details.content, details);
            assert.equal(input, data);
            assert.equal(scope, context);
            harness.render(target, config, input, scope);
        } }, element, { line, range, rangeManager, onInit, onChange, details }, data, context);
        const marker = element.children.filter(child => child.className === 'interval-marker')[1];
        assert.equal(marker.dataset.title, expected);
        assert.equal(initialized, 1);
        assert.equal(profile.timeline.range.selection.ranges, null);
        harness.destroy(element);
    }
});

test.each([false, true])('owns manager lifecycle, calls user onInit and adapts details, multiple=%s', async multiple => {
    const { profile } = await createProfileFixture();
    const manager = profile.timeline.range.selection;
    manager.setRange(102, 108);
    const input = { retained: true };
    const context = { primaryProfile: profile, primaryLineType: 'timeline' };
    let config;
    let api;
    let changes = 0;
    let cleanups = 0;
    let detailsContext;
    const harness = createRulerHarness((el, details, data, scope) => {
        assert.equal(data, input);
        detailsContext = details.context(data, scope);
    });
    const element = harness.createElement('ruler');
    harness.createElement('parent').appendChild(element);
    const details = { view: 'struct' };
    renderLineRuler.call({ render(el, props, data, scope) {
        config = props;
        return harness.render(el, props, data, scope);
    } }, element, { range: { start: 100, end: 130 }, segments: 7, multiple, rangeManager: manager, details,
        onInit(value, data, scope) {
            api = value;
            assert.equal(data, input);
            assert.equal(scope, context);
            return () => cleanups++;
        },
        onChange(value) {
            assert.equal(value, api); changes++;
        }
    }, input, context);
    assert.equal(config.segments, 7);
    assert.deepEqual(Array.from(api.state.segments), Array.from({ length: 8 }, (_, index) => 100 + index * 30 / 7));
    assert.deepEqual(api.state.selection, multiple ? [{ start: 102, end: 108 }] : { start: 102, end: 108 });
    manager.setRanges([{ start: 110, end: 115 }, { start: 120, end: 125 }]);
    assert.deepEqual(api.state.selection, multiple ? [{ start: 110, end: 115 }, { start: 120, end: 125 }] : { start: 110, end: 115 });
    manager.setRange(110, 115);
    assert.equal(changes, 0);
    assert.deepEqual(api.state.selection, multiple ? [{ start: 110, end: 115 }] : { start: 110, end: 115 });
    harness.setActive(element);
    harness.move({ x: element.width * 0.4, y: 5 });
    harness.showTooltip();
    assert.ok(resolveScopeProfileLine(null, detailsContext) === profile.timeline, 'Details use the existing line scope');
    assert.equal(detailsContext.timeStart, 10);
    assert.equal(detailsContext.timeEnd, 15);
    assert.equal(detailsContext.segmentStart, 2);
    assert.equal(detailsContext.segmentEnd, 3);
    assert.equal(config.details.content, details);
    assert.equal('segmentStart' in api.state, false);
    manager.resetRange();
    harness.move({ x: element.width * 0.4, y: 5 });
    harness.showTooltip();
    assert.ok(Math.abs(detailsContext.timeStart - 60 / 7) < 1e-12);
    assert.ok(Math.abs(detailsContext.timeEnd - 90 / 7) < 1e-12);
    assert.equal(api.state.selection, null);
    harness.pointerDown(element.width * 0.4, element);
    harness.move({ x: element.width * 0.7, y: 5 });
    harness.pointerUp(element.width * 0.7);
    assert.deepEqual(manager.ranges, [{ start: 100 + 60 / 7, end: 100 + 150 / 7 }]);
    assert.equal(changes, 1);
    const selected = api.state.selection;
    harness.destroy(element);
    manager.setRange(0, 30);
    assert.equal(api.state.selection, selected);
    assert.equal(cleanups, 1);
});

test('forwards explicit segment boundaries and fractional ranges without normalization', () => {
    const range = { start: -0.5, end: 0.5 };
    const segments = [-0.5, -0.25, 0.125, 0.5];
    const selection = [{ start: -1, end: 0.125 }];
    renderLineRuler.call({ render(el, config) {
        assert.equal(config.range, range);
        assert.equal(config.segments, segments);
        assert.equal(config.selection, selection);
    } }, {}, { range, segments, selection }, {}, { scopeLine: { type: 'timeline' } });
});

// A drag starts on a handle at `from`, reaches the opposite edge `anchor`, crosses it and returns.
// The handle stays on its `side` of the anchor until crossing.
const minimumResizeCases = [false, true].flatMap(multiple => [null, 10].flatMap(segments => [
    { multiple, segments, trigger: 'start', side: -1, from: 20, anchor: 60, crossed: 80 },
    { multiple, segments, trigger: 'finish', side: 1, from: 60, anchor: 20, crossed: 10 }
]));

test.each(minimumResizeCases)(
    'keeps a minimum resize in the manager and commits it after crossing the anchor: $trigger, segments=$segments, multiple=$multiple',
    ({ multiple, segments, trigger, side, from, anchor, crossed }) => {
        // The ruler is 100px wide over [100, 200], so a pointer offset is a scale offset
        const span = (first, second) => ({ start: 100 + Math.min(first, second), end: 100 + Math.max(first, second) });
        const selected = range => multiple ? [range] : range;
        // A segmented scale stops at the nearest boundary, a continuous one at one CSS pixel
        const minimum = segments ? 10 : 1;
        const manager = new RangeSelection({ name: 'time', unit: 'us' });
        const harness = createRulerHarness();
        const element = harness.createElement('ruler');
        const styles = new Map();
        let api;
        let commits = 0;

        manager.setRange(120, 160);
        element.width = 100;
        element.style.setProperty = (name, value) => styles.set(name, value);
        harness.createElement('parent').appendChild(element);
        renderLineRuler.call({ render: harness.render }, element, {
            range: [100, 200], segments, multiple, rangeManager: manager,
            onInit(value) {
                api = value;
            },
            onCommit() {
                commits++;
            }
        }, {}, { scopeLine: { type: 'timeline' } });
        harness.setActive(element);

        harness.pointerDown(from, harness.selectionHandle(element, trigger));
        harness.move({ x: anchor, y: 5 });
        const initial = span(anchor, anchor + side * minimum);
        assert.deepEqual(manager.ranges, [initial]);
        assert.deepEqual(api.state.selection, selected(initial));
        assert.equal(styles.get('--selection-start'), (initial.start - 100) / 100);
        assert.equal(styles.get('--selection-end'), (initial.end - 100) / 100);
        assert.equal(element.hasPointerCapture(1), true);

        harness.move({ x: crossed, y: 5 });
        assert.deepEqual(manager.ranges, [span(anchor, crossed)]);
        assert.deepEqual(api.state.selection, selected(span(anchor, crossed)));

        harness.move({ x: anchor, y: 5 });
        harness.pointerUp(anchor);
        const final = span(anchor, anchor - side * minimum);
        assert.deepEqual(manager.ranges, [final]);
        assert.deepEqual(api.state.selection, selected(final));
        assert.equal(element.dataset.state, 'selected');
        assert.equal(commits, 1);
        assert.equal(element.hasPointerCapture(1), false);
        harness.destroy(element);
    }
);

test('zoom moves the line viewport within its bounds and follows its changes', async () => {
    const { profile } = await createProfileFixture();
    const other = await createProfileFixture({ startTime: -20 });
    const line = profile.timeline;
    const harness = createRulerHarness();
    const element = harness.createElement('ruler');
    const context = { primaryProfile: profile, primaryLineType: 'timeline', data: { profiles: [profile, other.profile] } };
    const bounds = lineViewportBounds(line, context.data.profiles);
    let config;
    let api;

    element.width = 100;
    harness.createElement('parent').appendChild(element);
    line.viewport.selection.setRange(bounds.start + 10, bounds.start + 30);
    renderLineRuler.call({ render(el, props, data, scope) {
        config = props;
        return harness.render(el, props, data, scope);
    } }, element, { range: { start: 0, end: 1 }, zoom: true, onInit: value => {
        api = value;
    } }, null, context);
    harness.setActive(element);

    assert.deepEqual(config.bounds, bounds);
    assert.deepEqual(api.state.range, { start: bounds.start + 10, end: bounds.start + 30 });

    // Panning and zooming request the viewport of the line
    harness.wheel(50, { deltaX: 50 });
    assert.deepEqual(line.viewport.selection.ranges, [{ start: bounds.start + 20, end: bounds.start + 40 }]);
    harness.wheel(50, { deltaY: 10_000, ctrlKey: true });
    assert.deepEqual(api.state.range, bounds);
    assert.equal(line.viewport.selection.ranges, null);

    // Only the whole bounds are no request, a part of them at their start is
    harness.wheel(0, { deltaY: -500, ctrlKey: true });
    assert.equal(api.state.range.start, bounds.start);
    assert.deepEqual(line.viewport.selection.ranges, [api.state.range]);
    line.viewport.resetRange();

    // External changes of the viewport move the ruler
    line.viewport.selection.setRange(bounds.start + 5, bounds.start + 15);
    assert.deepEqual(api.state.range, { start: bounds.start + 5, end: bounds.start + 15 });
    line.viewport.resetRange();
    assert.deepEqual(api.state.range, bounds);

    const subscribe = line.viewport.subscribe;
    let unsubscribed = 0;

    // The following of the viewport ends with the ruler
    line.viewport.subscribe = callback => {
        const unsubscribe = subscribe.call(line.viewport, callback);

        return () => {
            unsubscribed++;
            unsubscribe();
        };
    };
    const zoomed = harness.createElement('ruler');

    renderLineRuler.call({ render: (el, props, data, scope) => harness.render(el, props, data, scope) },
        zoomed, { zoom: true }, null, context);
    delete line.viewport.subscribe;
    assert.equal(unsubscribed, 0);
    harness.destroy(zoomed);
    assert.equal(unsubscribed, 1);
});

test('zoom with a grid of bins segments the ruler by columns of bins and details by the bins', async () => {
    const { profile } = await createProfileFixture();
    const line = profile.timeline;
    const harness = createRulerHarness((el, details, data, scope) => {
        detailsContext = details.context(data, scope);
    });
    const element = harness.createElement('ruler');
    const context = { primaryProfile: profile, primaryLineType: 'timeline' };
    const bounds = lineViewportBounds(line);
    const grid = { start: bounds.start, end: bounds.start + 32 };
    let detailsContext;
    let api;

    element.width = 8;
    harness.createElement('parent').appendChild(element);
    line.viewport.selection.setRange(grid.start + 3, grid.start + 19);
    renderLineRuler.call({ render: (el, props, data, scope) => harness.render(el, props, data, scope) },
        element, { range: grid, segments: 64, zoom: true, details: { view: 'struct' }, onInit: value => {
            api = value;
        } }, null, context);
    harness.setActive(element);

    // 32 bins across 8 pixels merge by 8 into columns of 4, the edge ones are clipped
    assert.deepEqual(Array.from(api.state.segments), [3, 4, 8, 12, 16, 19].map(value => grid.start + value));

    harness.move({ x: 1.5, y: 5 });
    harness.showTooltip();
    assert.deepEqual([detailsContext.segmentStart, detailsContext.segmentEnd], [8, 15]);
    assert.deepEqual([detailsContext.timeStart, detailsContext.timeEnd], [4, 8]);
    harness.move({ x: 0.2, y: 5 });
    harness.showTooltip();
    assert.deepEqual([detailsContext.segmentStart, detailsContext.segmentEnd], [6, 7]);
    assert.deepEqual([detailsContext.timeStart, detailsContext.timeEnd], [3, 4]);

    // Zooming in splits the columns
    line.viewport.selection.setRange(grid.start + 4, grid.start + 8);
    assert.deepEqual(Array.from(api.state.segments), [4, 5, 6, 7, 8].map(value => grid.start + value));
    harness.move({ x: 2.5, y: 5 });
    harness.showTooltip();
    assert.deepEqual([detailsContext.segmentStart, detailsContext.segmentEnd], [10, 11]);
    harness.destroy(element);
    line.viewport.resetRange();
});
