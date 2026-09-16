import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { RangeSelection } from '../prepare/computations/range.js';
import { methods, binningRange } from './viewport.js';

const query = jora.setup({ methods });

function createLine(start = 120, end = 180) {
    return {
        kind: 'time' as const,
        axisStart: start - 5,
        axisEnd: end + 5,
        range: new RangeSelection({ name: 'time', unit: 'us' }).view({ start: 0, end: end - start }, start)
    };
}

test('accepts null viewport and uses local binning bounds', () => {
    const line = { ...createLine(), axisTotal: 60 };

    assert.deepEqual(binningRange(line, null, 10), {
        total: 60, skip: 0, step: 6, binStart: 0, binEnd: 10
    });
});

test('selects a common time viewport without changing line extent or mixing bytes into time', () => {
    const line = createLine();
    const profiles = [{ timeline: createLine(105, 195) }, { timeline: line }, {}];
    const data = { line, profiles };
    assert.deepEqual(query('line.lineViewport(@.profiles)')(data), { start: 100, end: 200 });
    assert.deepEqual(methods.lineExtent(line), { start: 120, end: 180 });
    assert.deepEqual(methods.lineViewport(line), { start: 120, end: 180 });
    assert.deepEqual(methods.lineViewport({ ...line, kind: 'memory' }, profiles), { start: 120, end: 180 });
});

test('resolves viewport gestures through a display frame without clipping the request or changing the population frame', () => {
    const line = createLine();
    const viewport = { start: 100, end: 200 };
    const display = query('viewport.viewportRange(line)')({ line, viewport });
    display.setRange(10, 40);
    assert.deepEqual(line.range.selection.ranges, [{ start: 110, end: 140 }]);
    assert.deepEqual(line.range.coverage, [{ start: 0, end: 20 }]);
    display.setRange(0, 10);
    assert.deepEqual(line.range.coverage, []);
    assert.deepEqual(line.range.selection.ranges, [{ start: 100, end: 110 }]);
    assert.equal(line.range.frame.origin, 120);
});
