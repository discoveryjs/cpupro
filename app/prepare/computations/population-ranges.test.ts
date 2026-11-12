import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Population, PopulationFiltered } from './population.js';
import type { PreparedAttributeFilter } from './attribute-filter.js';
import type { RangeSet } from './coordinates.js';
import { trackReads } from '../../../test/helpers/read-tracker.js';

const UNRESTRICTED: RangeSet = [{ start: -Infinity, end: Infinity }];

// Events of 100 at [0, 100) and [100, 200), samples 0 and 1
function createTwoEvents() {
    return new Population(Uint32Array.of(0, 1), Uint32Array.of(100, 100));
}

// Overlap of an event with the intersection of two sets of disjoint intervals, null for an unrestricted set
function overlapOf(start: number, end: number, source: RangeSet | null, own: RangeSet | null) {
    const outer = source ?? UNRESTRICTED;
    const inner = own ?? UNRESTRICTED;
    let overlap = 0;

    for (let i = 0; i < outer.length; i++) {
        for (let j = 0; j < inner.length; j++) {
            const from = Math.max(start, outer[i].start, inner[j].start);
            const to = Math.min(end, outer[i].end, inner[j].end);

            overlap += Math.max(0, to - from);
        }
    }

    return overlap;
}

// Destinations, values and metrics of a derived population from the overlap of every event with the source and
// own requests, independently of coverage, boundary cuts and source metrics: an event keeps its whole value when
// it overlaps, and its truncated overlap counts when nonzero
function expectedPopulation(base: Population, source: RangeSet | null, own: RangeSet | null, rejected: Uint8Array) {
    const { sinkId } = base;
    const samples = new Uint32Array(base.values.length);
    const values = new Uint32Array(base.values.length);
    const totals = new Float64Array(sinkId + 1);
    const counts = new Uint32Array(sinkId + 1);
    let rangeSamples = 0;

    for (let i = 0; i < base.values.length; i++) {
        const start = base.cumulative[i];
        const overlap = overlapOf(start, start + base.values[i], source, own);
        const contribution = Math.trunc(overlap);
        const sample = rejected[i] === 1 ? sinkId : base.samples[i];

        samples[i] = sample;

        if (overlap > 0) {
            values[i] = base.values[i];
            rangeSamples++;
        }

        if (contribution > 0) {
            totals[sample] += contribution;
            counts[sample]++;
        }
    }

    return {
        samples,
        values,
        samplesTotal: totals.subarray(0, sinkId),
        samplesCount: counts.subarray(0, sinkId),
        sink: { count: counts[sinkId], total: totals[sinkId] },
        rangeSamples: source === null && own === null ? null : rangeSamples
    };
}

// Samples with a value and no counted events: none, since metrics of trees and dictionaries skip a sample by its
// zero count
function valuedSamplesWithoutCount(population: PopulationFiltered) {
    const samples: number[] = [];

    for (let i = 0; i < population.samplesCount.length; i++) {
        if (population.samplesCount[i] === 0 && population.samplesTotal[i] !== 0) {
            samples.push(i);
        }
    }

    return samples;
}

function assertPopulation(actual: PopulationFiltered, expected: ReturnType<typeof expectedPopulation>) {
    assert.deepEqual(actual.samples, expected.samples);
    assert.deepEqual(actual.values, expected.values);
    assert.deepEqual(actual.samplesTotal, expected.samplesTotal);
    assert.deepEqual(actual.samplesCount, expected.samplesCount);
    assert.deepEqual(actual.sink, expected.sink);
    assert.equal(actual.rangeSamples, expected.rangeSamples);
    assert.deepEqual(valuedSamplesWithoutCount(actual), []);
}

// Ordered disjoint intervals between pairs of sorted coordinates, touching and empty ones included
function createRandomRanges(coordinates: number[], random: (max: number) => number) {
    const count = 2 * (1 + random(3));
    const points: number[] = [];
    const ranges: { start: number; end: number }[] = [];

    for (let i = 0; i < count; i++) {
        points.push(coordinates[random(coordinates.length)]);
    }

    points.sort((a, b) => a - b);

    for (let i = 0; i < count; i += 2) {
        ranges.push({ start: points[i], end: points[i + 1] });
    }

    return ranges;
}

// Deterministic pseudo-random sequence
function sequence(seed: number) {
    return (max: number) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;

        return seed % max;
    };
}

// Samples 0, 1, 2 in turn; the viewport rejects every 4th event, the selection also rejects sample 0
function createChain(weights: number[]) {
    const eventCount = weights.length;
    const samples = new Uint32Array(eventCount);
    const eventAccepts = new Uint8Array(eventCount);
    const viewportRejects = new Uint8Array(eventCount);
    const selectionRejects = new Uint8Array(eventCount);

    for (let i = 0; i < eventCount; i++) {
        samples[i] = i % 3;
        eventAccepts[i] = i % 4 === 3 ? 0 : 1;
        viewportRejects[i] = 1 - eventAccepts[i];
        selectionRejects[i] = samples[i] === 0 ? 1 : viewportRejects[i];
    }

    const base = new Population(samples, Uint32Array.from(weights));
    const viewport = new PopulationFiltered(base);
    const selection = new PopulationFiltered(viewport);
    const sampleCount = base.samplesCount.length;
    const sampleAccepts = new Uint8Array(sampleCount).fill(1);

    sampleAccepts[0] = 0;
    viewport.filter.set({
        key: 'events',
        domain: 'event',
        size: eventCount,
        accepts: eventAccepts
    });
    selection.filter.set({
        key: 'samples',
        domain: 'sample',
        size: sampleCount,
        accepts: sampleAccepts
    });

    return {
        base,
        viewport,
        selection,
        viewportRejects,
        selectionRejects
    };
}

// Event boundaries, points next to them and inside events, and points outside the population
function createCoordinates(base: Population) {
    const total = base.cumulativeEnd;
    const coordinates = [-1, total - 0.25, total, total + 1];

    for (let i = 0; i < base.values.length; i++) {
        const start = base.cumulative[i];

        coordinates.push(start - 0.25, start, start + 0.25, start + base.values[i] / 2);
    }

    return coordinates;
}

// Base events of samples 0, 0 and 1, and one in the sink of a 2-sample domain; the viewport rejects the second one
function createSinkChain() {
    const base = new Population(Uint32Array.of(0, 0, 1, 2), Uint32Array.of(10, 20, 30, 40), 2);
    const viewport = new PopulationFiltered(base);

    viewport.filter.set({
        key: 'source',
        domain: 'event',
        size: 4,
        accepts: Uint8Array.of(1, 0, 1, 1)
    });

    return {
        base,
        viewport,
        selection: new PopulationFiltered(viewport)
    };
}

test('intersects a local request with the source ranges', () => {
    const viewport = new PopulationFiltered(createTwoEvents());
    const selection = new PopulationFiltered(viewport);

    viewport.setRanges([{ start: 20, end: 35 }, { start: 45, end: 160 }]);
    selection.setRanges([{ start: 30, end: 50 }, { start: 90, end: 180 }]);

    assert.deepEqual(selection.requestedRanges, [{ start: 30, end: 50 }, { start: 90, end: 180 }]);
    assert.deepEqual(selection.ranges, [{ start: 30, end: 35 }, { start: 45, end: 50 }, { start: 90, end: 160 }]);
    assert.deepEqual([...selection.values], [100, 100]);
    assert.deepEqual([...selection.samplesTotal], [20, 60]);
    assert.deepEqual([...selection.samplesCount], [1, 1]);
});

test('inherits the source ranges without a request, while an empty request stays empty', () => {
    const viewport = new PopulationFiltered(createTwoEvents());
    const selection = new PopulationFiltered(viewport);

    viewport.setRange(20, 160);

    assert.equal(selection.requestedRanges, null);
    assert.deepEqual(selection.ranges, [{ start: 20, end: 160 }]);
    assert.deepEqual([...selection.samplesTotal], [80, 60]);

    selection.setRanges([]);
    viewport.resetRange();

    assert.deepEqual(selection.ranges, []);
    assert.deepEqual([...selection.values], [0, 0]);
    assert.deepEqual([...selection.samplesTotal], [0, 0]);
    assert.equal(selection.rangeSamples, 0);

    selection.resetRange();

    assert.equal(selection.ranges, null);
    assert.deepEqual([...selection.values], [100, 100]);
    assert.deepEqual([...selection.samplesTotal], [100, 100]);
    assert.equal(selection.rangeSamples, null);
});

test('keeps a request while the source ranges leave it and return', () => {
    const viewport = new PopulationFiltered(createTwoEvents());
    const selection = new PopulationFiltered(viewport);

    viewport.setRange(0, 100);
    selection.setRange(50, 150);

    assert.deepEqual(selection.ranges, [{ start: 50, end: 100 }]);
    assert.deepEqual([...selection.samplesTotal], [50, 0]);

    viewport.setRange(160, 200);

    assert.deepEqual(selection.ranges, []);
    assert.deepEqual(selection.requestedRanges, [{ start: 50, end: 150 }]);
    assert.deepEqual([...selection.samplesTotal], [0, 0]);

    viewport.resetRange();

    assert.deepEqual(selection.ranges, [{ start: 50, end: 150 }]);
    assert.deepEqual([...selection.samplesTotal], [50, 50]);
});

test('cuts boundary events of every level from their full weights', () => {
    const viewport = new PopulationFiltered(createTwoEvents());
    const selection = new PopulationFiltered(viewport);
    const nested = new PopulationFiltered(selection);

    // 0.625 + 0.625 of the first event: the total is truncated once, after summing
    viewport.setRanges([{ start: 0.25, end: 0.875 }, { start: 1.25, end: 1.875 }]);

    assert.deepEqual([...nested.values], [100, 0]);
    assert.deepEqual([...nested.samplesTotal], [1, 0]);
    assert.deepEqual([...nested.samplesCount], [1, 0]);
    assert.deepEqual(nested.boundaryCuts, [{ index: 0, value: 99, covered: 1.25 }]);

    // 0.625 of the first event: it keeps its weight but neither a total nor a count
    selection.setRange(0, 1);

    assert.deepEqual([...nested.values], [100, 0]);
    assert.deepEqual([...nested.samplesTotal], [0, 0]);
    assert.deepEqual([...nested.samplesCount], [0, 0]);
    assert.equal(nested.rangeSamples, 1);
});

test('notifies a derived population of a source range change that keeps its totals', () => {
    const viewport = new PopulationFiltered(createTwoEvents());
    const selection = new PopulationFiltered(viewport);
    let notifications = 0;

    viewport.setRange(0, 60);
    selection.setRange(10, 20);
    selection.subscribe(() => notifications++);
    viewport.setRange(0, 70);
    viewport.setRange(0, 70);

    assert.equal(notifications, 1);
    assert.deepEqual([...selection.samplesTotal], [10, 0]);
});

test('counts changes of destinations, not of ranges, in samplesRevision', () => {
    const viewport = new PopulationFiltered(createTwoEvents());
    const selection = new PopulationFiltered(viewport);

    selection.filter.set({ key: 'own', domain: 'sample', size: 2, accepts: Uint8Array.of(1, 0) });
    viewport.setRange(50, 150);
    selection.setRange(60, 140);

    assert.equal(selection.samplesRevision, 1);
    assert.deepEqual([...selection.samples], [0, 2]);

    viewport.filter.set({
        key: 'source',
        domain: 'event',
        size: 2,
        accepts: Uint8Array.of(0, 1)
    });

    assert.equal(selection.samplesRevision, 2);
    assert.deepEqual([...selection.samples], [2, 2]);
});

test('gives every derived population own buffers and stable vectors over the base axis', () => {
    const base = createTwoEvents();
    const viewport = new PopulationFiltered(base);
    const selection = new PopulationFiltered(viewport);
    const nested = new PopulationFiltered(selection);
    const samples = nested.samples;
    const values = nested.values;
    const buffers = new Set([
        viewport.buffer.memory!.buffer,
        selection.buffer.memory!.buffer,
        nested.buffer.memory!.buffer
    ]);

    viewport.setRange(50, 150);
    selection.filter.set({ key: 'own', domain: 'sample', size: 2, accepts: Uint8Array.of(1, 0) });

    assert.equal(buffers.size, 3);
    assert.equal(nested.samples, samples);
    assert.equal(nested.values, values);
    assert.deepEqual([...nested.samples], [0, 2]);
    assert.equal(nested.cumulative, base.cumulative);
    assert.equal(nested.cumulativeEnd, 200);
    assert.equal(nested.sinkId, 2);
});

test('keeps the last result after destroy', () => {
    const viewport = new PopulationFiltered(createTwoEvents());
    const selection = new PopulationFiltered(viewport);

    viewport.setRange(0, 150);
    selection.setRange(50, 200);

    assert.deepEqual([...selection.samplesTotal], [50, 50]);

    selection.destroy();
    selection.destroy();
    viewport.setRange(0, 50);

    assert.deepEqual(selection.ranges, [{ start: 50, end: 150 }]);
    assert.deepEqual([...selection.values], [100, 100]);
    assert.deepEqual([...selection.samplesTotal], [50, 50]);
});

test('keeps events of the source sink in the sink under own filters and ranges', () => {
    const { base, viewport, selection } = createSinkChain();

    assert.equal(base.sinkId, 2);
    assert.deepEqual(base.sink, { count: 1, total: 40 });
    assert.deepEqual([...selection.samples], [0, 2, 1, 2]);
    assert.deepEqual([...selection.samplesTotal], [10, 30]);
    assert.deepEqual(selection.sink, { count: 2, total: 60 });

    // Filters that accept everything still make the selection compile its own destinations
    selection.filter.set({ key: 'own', domain: 'sample', size: 2, accepts: Uint8Array.of(1, 1) });
    selection.filter.set({
        key: 'own events',
        domain: 'event',
        size: 4,
        accepts: Uint8Array.of(1, 1, 1, 1)
    });
    viewport.setRange(5, 85);
    selection.setRange(15, 75);

    assert.deepEqual([...selection.samples], [0, 2, 1, 2]);
    assert.deepEqual([...selection.values], [0, 20, 30, 40]);
    assert.deepEqual([...selection.samplesTotal], [0, 30]);
    assert.deepEqual(selection.sink, { count: 2, total: 30 });
});

test('restores a source sink event by a source update, not by a reset of own filters', () => {
    const { viewport, selection } = createSinkChain();

    viewport.setRange(5, 85);
    selection.filter.set({ key: 'own', domain: 'sample', size: 2, accepts: Uint8Array.of(1, 1) });
    selection.filter.remove('own');

    assert.deepEqual([...selection.samples], [0, 2, 1, 2]);

    viewport.filter.remove('source');

    assert.deepEqual([...selection.samples], [0, 0, 1, 2]);
    assert.deepEqual([...selection.samplesTotal], [25, 30]);
    assert.deepEqual(selection.sink, { count: 1, total: 25 });
});

test('adopts the source metrics without own filters and ranges', () => {
    const viewport = new PopulationFiltered(createTwoEvents());
    const selection = new PopulationFiltered(viewport);
    const sibling = new PopulationFiltered(viewport);

    viewport.filter.set({
        key: 'source',
        domain: 'sample',
        size: 2,
        accepts: Uint8Array.of(1, 0)
    });
    viewport.setRange(50, 150);

    assert.deepEqual([...selection.samplesTotal], [50, 0]);
    assert.deepEqual([...selection.samplesCount], [1, 0]);
    assert.deepEqual(selection.sink, { count: 1, total: 50 });

    selection.setRange(60, 200);

    assert.deepEqual([...selection.samplesTotal], [40, 0]);
    assert.deepEqual(selection.sink, { count: 1, total: 50 });
    assert.deepEqual([...sibling.samplesTotal], [50, 0]);
    assert.deepEqual(sibling.sink, { count: 1, total: 50 });
});

test('normalizes a request and clips it to the base extent', () => {
    const filtered = new PopulationFiltered(new Population(Uint32Array.of(0, 1, 0), Uint32Array.of(10, 20, 30)));

    filtered.setRanges([{ start: 35, end: 45 }, { start: 2, end: 4 }, { start: 6, end: 8 }]);

    assert.deepEqual(filtered.requestedRanges, [{ start: 2, end: 4 }, { start: 6, end: 8 }, { start: 35, end: 45 }]);

    filtered.setRanges([{ start: -2, end: 5 }, { start: 3, end: 8 }, { start: 40, end: 100 }]);

    assert.deepEqual(filtered.requestedRanges, [{ start: 0, end: 8 }, { start: 40, end: 60 }]);
    assert.deepEqual(filtered.ranges, [{ start: 0, end: 8 }, { start: 40, end: 60 }]);
});

test.each([
    {
        name: 'gaps between intervals',
        ranges: [{ start: 2, end: 4 }, { start: 6, end: 8 }, { start: 35, end: 45 }],
        values: [10, 0, 30],
        totals: [14, 0],
        counts: [2, 0],
        cuts: [{ index: 0, value: 6, covered: 4 }, { index: 2, value: 20, covered: 10 }]
    },
    {
        name: 'fractions of an event summed before truncation',
        ranges: [{ start: 0.25, end: 0.875 }, { start: 1.25, end: 1.875 }],
        values: [10, 0, 0],
        totals: [1, 0],
        counts: [1, 0],
        cuts: [{ index: 0, value: 9, covered: 1.25 }]
    }
])('takes whole weights of covered events and cuts each edge event once: $name', row => {
    const filtered = new PopulationFiltered(new Population(Uint32Array.of(0, 1, 0), Uint32Array.of(10, 20, 30)));

    filtered.setRanges(row.ranges);

    assert.deepEqual([...filtered.values], row.values);
    assert.deepEqual([...filtered.samplesTotal], row.totals);
    assert.deepEqual([...filtered.samplesCount], row.counts);
    assert.deepEqual(filtered.boundaryCuts, row.cuts);
});

test('counts covered events in rangeSamples before masks', () => {
    const filtered = new PopulationFiltered(new Population(Uint32Array.of(0, 1, 0), Uint32Array.of(10, 20, 30)));

    filtered.filter.set({
        key: 'samples',
        domain: 'sample',
        size: 2,
        accepts: Uint8Array.of(0, 0)
    });
    filtered.setRange(5, 15);

    assert.equal(filtered.rangeSamples, 2);
    assert.deepEqual(filtered.sink, { count: 2, total: 10 });

    filtered.setRanges([]);

    assert.equal(filtered.rangeSamples, 0);
    assert.deepEqual(filtered.sink, { count: 0, total: 0 });

    filtered.resetRange();

    assert.equal(filtered.rangeSamples, null);
    assert.deepEqual(filtered.sink, { count: 3, total: 60 });
});

test.each([
    {
        domain: 'sample',
        size: 2,
        accepts: [1, 0]
    },
    {
        domain: 'event',
        size: 3,
        accepts: [1, 0, 1]
    }
] as const)('keeps a $domain filter through range changes and the range through filter changes', row => {
    const population = new PopulationFiltered(new Population(Uint32Array.of(0, 1, 0), Uint32Array.of(10, 20, 30)));
    const prepared: PreparedAttributeFilter = {
        key: 'attribute',
        domain: row.domain,
        size: row.size,
        accepts: Uint8Array.from(row.accepts)
    };

    population.setRange(5, 35);
    population.filter.set(prepared);

    assert.deepEqual([...population.samplesTotal], [10, 0]);
    assert.deepEqual(population.sink, { count: 1, total: 20 });

    population.resetRange();

    assert.equal(population.filter.get('attribute'), prepared);
    assert.deepEqual([...population.samplesTotal], [40, 0]);
    assert.deepEqual(population.sink, { count: 1, total: 20 });

    population.setRange(5, 35);
    population.filter.remove('attribute');

    assert.deepEqual(population.ranges, [{ start: 5, end: 35 }]);
    assert.deepEqual([...population.samplesTotal], [10, 20]);
    assert.deepEqual(population.sink, { count: 0, total: 0 });
});

test.each([
    { name: 'empty', weights: [] },
    { name: 'zero weights', weights: [0, 0, 0] },
    { name: 'single event', weights: [10] },
    { name: 'repeated coordinates', weights: [0, 0, 10, 0, 20, 0, 0, 30, 0, 40, 0] },
    { name: 'uint32 boundary', weights: [0xfffffffe, 1, 0] },
    { name: 'beyond uint32', weights: [0xffffffff, 0xffffffff, 3, 0, 0xffffffff, 7] }
])('matches the overlap of every event with the requests of a source and a derived: $name', row => {
    const { base, viewport, selection, viewportRejects, selectionRejects } = createChain(row.weights);
    const coordinates = createCoordinates(base);
    const random = sequence(54321);

    for (let i = 0; i < 60; i++) {
        const sourceRanges = createRandomRanges(coordinates, random);
        const ownRanges = createRandomRanges(coordinates, random);

        viewport.setRanges(sourceRanges);
        assertPopulation(selection, expectedPopulation(base, sourceRanges, null, selectionRejects));

        selection.setRanges(ownRanges);
        assertPopulation(viewport, expectedPopulation(base, sourceRanges, null, viewportRejects));
        assertPopulation(selection, expectedPopulation(base, sourceRanges, ownRanges, selectionRejects));

        viewport.resetRange();
        assertPopulation(selection, expectedPopulation(base, null, ownRanges, selectionRejects));

        selection.resetRange();
        assertPopulation(selection, expectedPopulation(base, null, null, selectionRejects));
    }
});

test('reads event weights only at interval edges and in covered events, not in gaps', () => {
    const base = new Population(new Uint32Array(100_000), new Uint32Array(100_000).fill(10));
    const filtered = new PopulationFiltered(base);
    const values = trackReads(base.values);

    base.values = values.array;
    filtered.setRanges([{ start: 100, end: 200 }, { start: 900_000, end: 900_100 }]);

    // Preparing ranges reads only the edge events of each interval
    assert.ok(values.reads.length <= 2 * 3, `reads of range preparation: ${values.reads.length}`);
    assert.equal(filtered.rangeSamples, 20);
    assert.equal(filtered.samplesTotal[0], 200);
    assert.equal(filtered.values[1000], 0);
    assert.deepEqual([...new Set(values.reads)].sort((a, b) => a - b), [
        10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
        90_000, 90_001, 90_002, 90_003, 90_004, 90_005, 90_006, 90_007, 90_008, 90_009
    ]);
});
