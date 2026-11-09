import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { methods, binningRange, setLineZoom, subscribeLineZoom } from './viewport.js';
import { createLineFixture, denseValues } from '../../test/fixtures/profile.js';

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

test('viewport bounds are the viewport without a request, also with the common time bounds', async () => {
    const { line } = await createLineFixture({ origin: 120, values: new Uint32Array([60]) });
    const other = await createLineFixture({ origin: 105, values: new Uint32Array([90]) });

    line.viewport.selection.setRange(130, 150);
    assert.deepEqual(methods.lineViewport(line), { start: 130, end: 150 });
    assert.deepEqual(methods.lineViewportBounds(line), { start: 120, end: 180 });
    assert.deepEqual(methods.lineViewportBounds(line, [other.profile]), { start: 105, end: 195 });
    line.viewport.resetRange();
    assert.deepEqual(methods.lineViewport(line, [other.profile]), methods.lineViewportBounds(line, [other.profile]));
});

test('the zoom is displayed within the viewport, requests are kept within it and the whole viewport is no request', async () => {
    const { line } = await createLineFixture({ origin: 100, values: denseValues(100) });
    const other = await createLineFixture({ origin: 50, values: new Uint32Array([200]) });
    const profiles = [other.profile];
    let changes = 0;
    const unsubscribe = subscribeLineZoom(line, () => changes++);

    // Without requests the zoom is the viewport, i.e. its bounds
    assert.deepEqual(query('lineZoom(#.profiles)')(line, { profiles }), { start: 50, end: 250 });
    line.zoom.selection.setRange(120, 140);
    assert.deepEqual(query('lineZoom(#.profiles)')(line, { profiles }), { start: 120, end: 140 });
    line.zoom.resetRange();

    // A new viewport changes the displayed range too
    line.viewport.selection.setRange(100, 200);
    assert.deepEqual(query('lineZoom()')(line), { start: 100, end: 200 });
    assert.equal(changes, 3);

    setLineZoom(line, profiles, { start: 120, end: 140 });
    assert.deepEqual(line.zoom.selection.ranges, [{ start: 120, end: 140 }]);
    // Moved inside the viewport, a longer one is clipped to it
    setLineZoom(line, profiles, { start: 90, end: 110 });
    assert.deepEqual(line.zoom.selection.ranges, [{ start: 100, end: 120 }]);
    setLineZoom(line, profiles, { start: 190, end: 230 });
    assert.deepEqual(line.zoom.selection.ranges, [{ start: 160, end: 200 }]);
    setLineZoom(line, profiles, { start: 120, end: 300 });
    assert.equal(line.zoom.selection.ranges, null);
    setLineZoom(line, profiles, { start: 120, end: 140 });
    setLineZoom(line, profiles, { start: 100, end: 200 });
    assert.equal(line.zoom.selection.ranges, null);
    assert.equal(changes, 9);

    unsubscribe();
    line.viewport.resetRange();
    line.zoom.selection.setRange(120, 140);
    assert.equal(changes, 9);
    line.zoom.resetRange();
});

test('zooming in stops at the length holding 500 events at the average density of the viewport, around the request', async () => {
    // A dense half of 100 events per unit and a sparse half of an event per unit
    const values = new Uint32Array([...denseValues(50), ...denseValues(50, 1)]);
    const { line } = await createLineFixture({ values });
    const minLength = query('lineZoomMinLength()');

    assert.equal(minLength(line), 100 * 500 / 5050);
    line.viewport.selection.setRange(0, 50);
    assert.equal(minLength(line), 5);

    // The current zoom scales around the point the request scales it around, until the shortest zoom
    setLineZoom(line, [], { start: 10, end: 30 });
    setLineZoom(line, [], { start: 14.5, end: 16.5 });
    assert.deepEqual(line.zoom.selection.ranges, [{ start: 13.75, end: 18.75 }]);
    setLineZoom(line, [], { start: 15, end: 16 });
    assert.deepEqual(line.zoom.selection.ranges, [{ start: 13.75, end: 18.75 }]);
    // Panning at the shortest zoom keeps it
    setLineZoom(line, [], { start: 20, end: 25 });
    assert.deepEqual(line.zoom.selection.ranges, [{ start: 20, end: 25 }]);

    // Sparse data zooms in less, and not at all with fewer events than that in the viewport
    line.viewport.selection.setRange(0, 60);
    assert.equal(minLength(line), 60 * 500 / 5010);
    line.viewport.selection.setRange(50, 100);
    assert.equal(minLength(line), 50);
    setLineZoom(line, [], { start: 60, end: 70 });
    assert.equal(line.zoom.selection.ranges, null);
    line.viewport.resetRange();
});
