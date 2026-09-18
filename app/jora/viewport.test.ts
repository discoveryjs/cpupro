import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { methods, binningRange } from './viewport.js';
import { createLineFixture } from '../../test/fixtures/profile.js';

const query = jora.setup({ methods });

test.each(['timeline', 'memline'] as const)('shared line fixture keeps a coherent and independent %s graph', async type => {
    const first = await createLineFixture({ type, origin: 120 });
    const second = await createLineFixture({ type, origin: 120 });
    const { line, profile, breakdown } = first;
    assert.equal(profile[type], line);
    assert.deepEqual(profile.lines, [line]);
    assert.equal(line.profile, profile);
    assert.equal(breakdown.line, line);
    assert.equal(line.breakdowns[0], breakdown);
    assert.equal(breakdown.population.values, line.values);
    assert.equal(breakdown.populationViewport.source, breakdown.population);
    assert.equal(breakdown.populationFiltered.source, breakdown.populationViewport);
    assert.equal(line.range.frame, line.viewport.frame);
    assert.equal(line.range.selection.space, line.viewport.selection.space);
    assert.notEqual(line.range.selection, line.viewport.selection);
    line.viewport.setRange(5, 15);
    assert.equal(line.range.selection.ranges, null);
    assert.deepEqual(breakdown.populationFiltered.ranges, [{ start: 5, end: 15 }]);
    assert.equal(second.line.viewport.selection.ranges, null);
    assert.equal(second.breakdown.populationFiltered.ranges, null);
});

test('accepts null viewport and uses local binning bounds', async () => {
    const { line } = await createLineFixture({ origin: 120, values: new Uint32Array([60]), before: 5, after: 5 });

    assert.deepEqual(binningRange(line, null, 10), {
        total: 60, skip: 0, step: 6, binStart: 0, binEnd: 10
    });
});

test('selects a common time viewport without changing line extent or mixing bytes into time', async () => {
    const { line } = await createLineFixture({ origin: 120, values: new Uint32Array([60]), before: 5, after: 5 });
    const other = await createLineFixture({ origin: 105, values: new Uint32Array([90]), before: 5, after: 5 });
    const memory = await createLineFixture({ type: 'memline', origin: 120, values: new Uint32Array([60]) });
    const profiles = [other.profile, line.profile, { timeline: null }];
    const data = { line, profiles };
    assert.deepEqual(query('line.lineViewport(@.profiles)')(data), { start: 100, end: 200 });
    assert.deepEqual(methods.lineExtent(line), { start: 120, end: 180 });
    assert.deepEqual(methods.lineViewport(line), { start: 120, end: 180 });
    assert.deepEqual(methods.lineViewport(memory.line, profiles), { start: 120, end: 180 });
});

test('uses the requested viewport envelope without changing selection or Base extent', async () => {
    const { line } = await createLineFixture({ origin: 120, values: new Uint32Array([60]), before: 5, after: 5 });
    line.range.selection.setRange(110, 190);
    const selection = line.range.selection.ranges;
    line.viewport.selection.setRanges([{ start: 130, end: 140 }, { start: 155, end: 170 }]);
    assert.deepEqual(methods.lineViewport(line), { start: 130, end: 170 });
    assert.deepEqual(methods.lineExtent(line), { start: 120, end: 180 });
    assert.equal(line.range.selection.ranges, selection);
    line.viewport.selection.setRanges([]);
    assert.deepEqual(methods.lineViewport(line), { start: 120, end: 120 });
    line.viewport.resetRange();
    const other = await createLineFixture({ origin: 105, values: new Uint32Array([90]), before: 5, after: 5 });
    assert.deepEqual(methods.lineViewport(line, [other.profile]), { start: 100, end: 200 });
});

test('resolves viewport gestures through a display frame without clipping the request or changing the population frame', async () => {
    const { line } = await createLineFixture({ origin: 120, values: new Uint32Array([60]), before: 5, after: 5 });
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
