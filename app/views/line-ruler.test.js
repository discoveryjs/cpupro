import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';
import { createRulerHarness } from '../../test/helpers/ruler.js';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import { resolveScopeProfileLine } from '../jora/profile.js';
import { formatMicrosecondsTime } from '../prepare/misc/time-utils.js';
import { rangeToSegments } from './ruler-range.js';
import { RangeSelection } from '../prepare/computations/range.js';

let renderLineRuler;
let viewOptions;
runInNewContext(readFileSync(new URL('./line-ruler.js', import.meta.url), 'utf8'), {
    discovery: { view: { define(name, render, options) {
        assert.equal(name, 'line-ruler');
        renderLineRuler = render;
        viewOptions = options;
    } } },
    require: () => ({ resolveScopeProfileLine, formatMicrosecondsTime, rangeToSegments })
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
        element.children.find(child => child.tag === 'destroy-ruler').onDestroy();
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
    manager.setRange(110, 115);
    assert.equal(changes, 0);
    assert.deepEqual(api.state.selection, multiple ? [{ start: 110, end: 115 }] : { start: 110, end: 115 });
    harness.setActive(element);
    harness.move({ x: element.width * 0.4, y: 5 });
    harness.showTooltip();
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
    harness.hostEvents.get('pointerdown')({ buttons: 1, pointerId: 1, x: element.width * 0.4, y: 5, target: element });
    harness.move({ x: element.width * 0.7, y: 5 });
    harness.globalEvents.get('pointerup')({ pointerId: 1, x: element.width * 0.7, y: 5 });
    assert.deepEqual(manager.ranges, [{ start: 100 + 60 / 7, end: 100 + 150 / 7 }]);
    assert.equal(changes, 1);
    const selected = api.state.selection;
    element.children.find(child => child.tag === 'destroy-ruler').onDestroy();
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

test.each([false, true])('keeps a minimum resize in the manager and commits it after crossing the anchor, multiple=%s', multiple => {
    for (const segments of [null, 10]) {
        for (const trigger of ['start', 'finish']) {
            const manager = new RangeSelection({ name: 'time', unit: 'us' });
            manager.setRange(120, 160);
            const harness = createRulerHarness();
            const element = harness.createElement('ruler');
            element.width = 100;
            const styles = new Map();
            element.style.setProperty = (name, value) => styles.set(name, value);
            harness.createElement('parent').appendChild(element);
            let api;
            let commits = 0;
            renderLineRuler.call({ render: harness.render }, element, {
                range: [100, 200], segments, multiple, rangeManager: manager,
                onInit(value) {
                    api = value;
                },
                onCommit() {
                    commits++;
                }
            }, {}, { scopeLine: { type: 'timeline' } });
            const handle = element.querySelector('.view-ruler__selection-overlay-mover')
                .children.find(child => child.dataset.trigger === trigger);
            const start = trigger === 'start' ? 20 : 60;
            const anchor = trigger === 'start' ? 60 : 20;
            const crossed = trigger === 'start' ? 80 : 10;
            harness.setActive(element);
            harness.move({ x: start, y: 5 });
            harness.hostEvents.get('pointerdown')({ buttons: 1, pointerId: 1, x: start, y: 5, target: handle });
            harness.move({ x: anchor, y: 5 });
            const minimum = segments ? 10 : 1;
            const initialMinimum = trigger === 'start'
                ? { start: 100 + anchor - minimum, end: 100 + anchor }
                : { start: 100 + anchor, end: 100 + anchor + minimum };
            assert.deepEqual(manager.ranges, [initialMinimum]);
            assert.deepEqual(api.state.selection, multiple ? [initialMinimum] : initialMinimum);
            assert.equal(styles.get('--selection-start'), (initialMinimum.start - 100) / 100);
            assert.equal(styles.get('--selection-end'), (initialMinimum.end - 100) / 100);
            assert.equal(element.hasPointerCapture(1), true);
            harness.move({ x: crossed, y: 5 });
            const selection = { start: 100 + Math.min(anchor, crossed), end: 100 + Math.max(anchor, crossed) };
            assert.deepEqual(manager.ranges, [selection]);
            assert.deepEqual(api.state.selection, multiple ? [selection] : selection);
            harness.move({ x: anchor, y: 5 });
            const finalMinimum = trigger === 'start'
                ? { start: 100 + anchor, end: 100 + anchor + minimum }
                : { start: 100 + anchor - minimum, end: 100 + anchor };
            harness.globalEvents.get('pointerup')({ pointerId: 1, x: anchor, y: 5 });
            assert.deepEqual(manager.ranges, [finalMinimum]);
            assert.deepEqual(api.state.selection, multiple ? [finalMinimum] : finalMinimum);
            assert.equal(element.dataset.state, 'selected');
            assert.equal(commits, 1);
            assert.equal(element.hasPointerCapture(1), false);
            element.children.find(child => child.tag === 'destroy-ruler').onDestroy();
        }
    }
});
