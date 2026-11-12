import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { methods, binningRange, rangeBins, setLineZoom, subscribeLineZoom, timestampExtent } from './viewport.js';
import { createLineFixture, denseValues, joinSession } from '../../test/fixtures/profile.js';

const query = jora.setup({ methods });

// A timeline over 120–180 with 5 units without samples on each side, another over 105–195 and a memline
// over 120–180
async function createTimelines() {
    const { line } = await createLineFixture({ origin: 120, values: new Uint32Array([60]), before: 5, after: 5 });
    const other = await createLineFixture({ origin: 105, values: new Uint32Array([90]), before: 5, after: 5 });
    const memory = await createLineFixture({ type: 'memline', origin: 120, values: new Uint32Array([60]) });

    return { line, other: other.profile, memory: memory.line };
}

test.each([
    {
        name: 'the extent of the line without a request',
        ranges: null,
        peers: false,
        viewport: { start: 120, end: 180 }
    },
    {
        name: 'the time bounds of the profiles of its recording without a request',
        ranges: null,
        peers: true,
        viewport: { start: 100, end: 200 }
    },
    {
        name: 'the envelope of the requested ranges',
        ranges: [{ start: 130, end: 140 }, { start: 155, end: 170 }],
        peers: true,
        viewport: { start: 130, end: 170 }
    },
    {
        name: 'the start of the extent for an empty request',
        ranges: [],
        peers: false,
        viewport: { start: 120, end: 120 }
    }
])('the viewport of a timeline is $name', async row => {
    const { ranges, peers, viewport } = row;
    const { line, other, memory } = await createTimelines();

    if (peers) {
        joinSession([other, line.profile, memory.profile]);
    }

    line.viewport.selection.setRanges(ranges);

    assert.deepEqual(query('lineViewport()')(line), viewport);
    assert.deepEqual(methods.lineExtent(line), { start: 120, end: 180 });
});

test('viewport bounds are the viewport without a request, cumulative bytes take no time bounds', async () => {
    const { line, other, memory } = await createTimelines();

    line.viewport.selection.setRange(130, 150);
    assert.deepEqual(methods.lineViewportBounds(line), { start: 120, end: 180 });
    joinSession([line.profile, other, memory.profile]);
    assert.deepEqual(methods.lineViewportBounds(line), { start: 100, end: 200 });
    assert.deepEqual(methods.lineViewport(memory), { start: 120, end: 180 });
});

test.each([
    { lastTime: 0, origin: undefined, extent: { start: 100, end: 200 } },
    { lastTime: 150, origin: undefined, extent: { start: 100, end: 250 } },
    { lastTime: 150, origin: 0, extent: { start: 100, end: 200 } }
])('a timestamp extent of a line over 100–200 with the last time $lastTime from $origin is $extent', row => {
    assert.deepEqual(timestampExtent({ axisStart: 100, axisEnd: 200 }, row.lastTime, row.origin), row.extent);
});

test('gestures in a display frame neither clip the request nor move the population frame', async () => {
    const { line } = await createLineFixture({ origin: 120, values: new Uint32Array([60]), before: 5, after: 5 });
    const display = query('viewport.viewportRange(line)')({ line, viewport: { start: 100, end: 200 } });

    display.setRange(10, 40);
    assert.deepEqual(line.range.selection.ranges, [{ start: 110, end: 140 }]);
    assert.deepEqual(line.range.coverage, [{ start: 0, end: 20 }]);
    display.setRange(0, 10);
    assert.deepEqual(line.range.selection.ranges, [{ start: 100, end: 110 }]);
    assert.deepEqual(line.range.coverage, []);
    // The display extent is the length of the viewport
    display.setRange(90, 120);
    assert.deepEqual(display.coverage, [{ start: 90, end: 100 }]);
    assert.equal(line.range.frame.origin, 120);

    assert.throws(() => methods.viewportRange({ start: 200, end: 100 }, line));
});

test.each([
    {
        name: 'without a viewport, the local axis',
        viewport: null,
        bins: {
            total: 60,
            skip: 0,
            step: 6,
            binStart: 0,
            binEnd: 10
        }
    },
    {
        name: 'with a viewport, the line extent in it',
        viewport: { start: 100, end: 200 },
        bins: {
            total: 100,
            skip: 20,
            step: 10,
            binStart: 1,
            binEnd: 8
        }
    }
])('binning range $name', async row => {
    const { line } = await createLineFixture({ origin: 120, values: new Uint32Array([60]), before: 5, after: 5 });

    assert.deepEqual(binningRange(line, row.viewport, 10), row.bins);
});

// Bins of 10 over the viewport
test.each([
    [0, 25, 55, 2, 6],
    // The end at a boundary is in the bin it ends, the start at a boundary too
    [0, 25, 50, 2, 5],
    [0, 20, 55, 1, 6],
    // An extent of an instant has a bin, also at a boundary
    [0, 25, 25, 2, 3],
    [0, 30, 30, 2, 3],
    // Viewport edges
    [0, 0, 100, 0, 10],
    [0, -10, 0, 0, 0],
    [0, 100, 120, 9, 10],
    // A viewport from 100
    [100, 125, 155, 2, 6],
    [100, 130, 130, 2, 3],
    [100, 200, 220, 9, 10]
])(
    'bins of a closed extent in a viewport from %i: %i–%i takes bins %i–%i',
    (viewportStart, start, end, binStart, binEnd) => {
        const bins = rangeBins({ start, end }, { start: viewportStart, end: viewportStart + 100 }, 10);

        assert.deepEqual([bins.binStart, bins.binEnd], [binStart, binEnd]);
    }
);

// A line of 10000 events over 100–200, and a profile of its recording over 50–250
async function createZoomLine() {
    const { line } = await createLineFixture({ origin: 100, values: denseValues(100) });
    const other = await createLineFixture({ origin: 50, values: new Uint32Array([200]) });

    joinSession([line.profile, other.profile]);

    return { line };
}

test.each([
    {
        name: 'the viewport bounds without requests',
        viewport: null,
        zoom: null,
        displayed: { start: 50, end: 250 }
    },
    {
        name: 'the zoom request',
        viewport: null,
        zoom: { start: 120, end: 140 },
        displayed: { start: 120, end: 140 }
    },
    {
        name: 'the viewport without a zoom request',
        viewport: { start: 100, end: 200 },
        zoom: null,
        displayed: { start: 100, end: 200 }
    }
])('the displayed range is $name', async row => {
    const { viewport, zoom, displayed } = row;
    const { line } = await createZoomLine();

    line.viewport.selection.setRanges(viewport && [viewport]);
    line.zoom.selection.setRanges(zoom && [zoom]);

    assert.deepEqual(query('lineZoom()')(line), displayed);
});

test('changes of the viewport and of the zoom are followed until unsubscribed', async () => {
    const { line } = await createZoomLine();
    let changes = 0;
    const unsubscribe = subscribeLineZoom(line, () => changes++);

    line.viewport.selection.setRange(100, 200);
    line.zoom.selection.setRange(120, 140);
    assert.equal(changes, 2);

    unsubscribe();
    line.zoom.selection.setRange(130, 140);
    line.viewport.resetRange();
    assert.equal(changes, 2);
});

test.each([
    {
        name: 'within the viewport',
        zoom: null,
        request: { start: 120, end: 140 },
        ranges: [{ start: 120, end: 140 }]
    },
    {
        name: 'before the viewport',
        zoom: null,
        request: { start: 90, end: 110 },
        ranges: [{ start: 100, end: 120 }]
    },
    {
        name: 'after the viewport',
        zoom: null,
        request: { start: 190, end: 230 },
        ranges: [{ start: 160, end: 200 }]
    },
    {
        name: 'longer than the viewport',
        zoom: { start: 120, end: 140 },
        request: { start: 120, end: 300 },
        ranges: null
    },
    {
        name: 'of the whole viewport',
        zoom: { start: 120, end: 140 },
        request: { start: 100, end: 200 },
        ranges: null
    }
])('a zoom request $name of 100–200 is kept within it, the whole viewport is no request', async row => {
    const { zoom, request, ranges } = row;
    const { line } = await createZoomLine();

    line.viewport.selection.setRange(100, 200);
    line.zoom.selection.setRanges(zoom && [zoom]);
    setLineZoom(line, request);

    assert.deepEqual(line.zoom.selection.ranges, ranges);
});

// A dense half of 100 events per unit and a sparse half of an event per unit
async function createDensityLine() {
    const values = new Uint32Array([...denseValues(50), ...denseValues(50, 1)]);
    const { line } = await createLineFixture({ values });

    return line;
}

test.each([
    { viewport: null, length: 100 * 500 / 5050 },
    { viewport: { start: 0, end: 50 }, length: 5 },
    // Sparse data zooms in less, and not at all with fewer events than that in the viewport
    { viewport: { start: 0, end: 60 }, length: 60 * 500 / 5010 },
    { viewport: { start: 50, end: 100 }, length: 50 }
])('the shortest zoom of the viewport $viewport holds 500 events at its average density', async row => {
    const line = await createDensityLine();

    line.viewport.selection.setRanges(row.viewport && [row.viewport]);

    assert.equal(query('lineZoomMinLength()')(line), row.length);
});

test('zooming in stops at the shortest zoom around the point the request scales the current zoom around', async () => {
    const line = await createDensityLine();

    line.viewport.selection.setRange(0, 50);
    setLineZoom(line, { start: 10, end: 30 });
    setLineZoom(line, { start: 14.5, end: 16.5 });
    assert.deepEqual(line.zoom.selection.ranges, [{ start: 13.75, end: 18.75 }]);
    setLineZoom(line, { start: 15, end: 16 });
    assert.deepEqual(line.zoom.selection.ranges, [{ start: 13.75, end: 18.75 }]);
    // Panning at the shortest zoom keeps it
    setLineZoom(line, { start: 20, end: 25 });
    assert.deepEqual(line.zoom.selection.ranges, [{ start: 20, end: 25 }]);
    // A zoom below the shortest one (e.g. shared by a profile with denser data) panned to a request shorter than
    // the shortest one: the shortest zoom around the middle of the request
    line.zoom.selection.setRange(20, 22);
    setLineZoom(line, { start: 30, end: 32 });
    assert.deepEqual(line.zoom.selection.ranges, [{ start: 28.5, end: 33.5 }]);

    line.viewport.selection.setRange(50, 100);
    setLineZoom(line, { start: 60, end: 70 });
    assert.equal(line.zoom.selection.ranges, null);
});
