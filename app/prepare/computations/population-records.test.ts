import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Population, PopulationFiltered } from './population.js';
import { PopulationRecords } from './population-records.js';
import type { EventClasses } from './population-filter.js';

type EventValues = Uint8Array | Uint16Array | Uint32Array;

// Deterministic pseudo-random sequence
function sequence(seed: number) {
    return (max: number) => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;

        return (seed >>> 8) % max;
    };
}

// Classes of events with equal values of every vector, numbered in the order of their first events
function classify(vectors: EventValues[], eventCount: number): EventClasses {
    const ids = new Uint16Array(eventCount);
    const classIds = new Map<string, number>();
    const events: number[] = [];

    for (let event = 0; event < eventCount; event++) {
        const key = vectors.map(values => values[event]).join(',');
        let id = classIds.get(key);

        if (id === undefined) {
            id = events.push(event) - 1;
            classIds.set(key, id);
        }

        ids[event] = id;
    }

    return { ids, events: Uint32Array.from(events), values: new Set(vectors) };
}

function createRecords(population: Population, classes = classify([], population.values.length)) {
    return new PopulationRecords(population.samples, population.values, population.cumulative, population.cumulativeEnd, classes);
}

// Records as sums per part, sample and class, in this order
function recordsOf(records: PopulationRecords) {
    const result: { part: number; sample: number; eventClass: number; weight: number; count: number }[] = [];

    for (let part = 0; part < records.partCount; part++) {
        for (let record = records.partStarts[part]; record < records.partStarts[part + 1]; record++) {
            const key = records.recordKeys[record];

            result.push({
                part,
                sample: records.keySamples[key],
                eventClass: records.keyClasses[key],
                weight: records.recordWeights[record],
                count: records.recordCounts[record]
            });
        }
    }

    return result.sort((a, b) => a.part - b.part || a.sample - b.sample || a.eventClass - b.eventClass);
}

// Counts reads of single events of a base vector
function countReads(population: Population, key: 'samples' | 'values') {
    const reads = { count: 0 };

    population[key] = new Proxy(population[key], {
        get(target, property) {
            if (typeof property === 'string' && /^\d+$/.test(property)) {
                reads.count++;
            }

            return Reflect.get(target, property, target);
        }
    });

    return reads;
}

// Runs of equal samples and classes, some zero values, about 4 events per part; values of the scaled
// fixture sum beyond 2^32 within a part
function createFixture(scale = 1) {
    const random = sequence(11);
    const eventCount = 8000;
    const samples = new Uint32Array(eventCount);
    const values = new Uint32Array(eventCount);
    const lifespan = new Uint8Array(eventCount);
    const space = new Uint8Array(eventCount);
    const other = new Uint8Array(eventCount);

    for (let event = 0, sample = 0; event < eventCount; event++) {
        sample = random(4) === 0 ? random(50) : sample;
        samples[event] = sample;
        values[event] = random(6) === 0 ? 0 : (1 + random(900)) * scale;
        lifespan[event] = random(3);
        space[event] = random(5);
        other[event] = random(2);
    }

    const population = new Population(samples, values, 50);

    return {
        population,
        lifespan,
        space,
        other,
        records: createRecords(population, classify([lifespan, space], eventCount))
    };
}

// Events of value 1 and 7 samples in turn: the 2000-bin grid has parts of 10 events
function createRegularFixture() {
    const eventCount = 20_000;
    const samples = Uint32Array.from({ length: eventCount }, (_, event) => event % 7);
    const lifespan = Uint8Array.from({ length: eventCount }, (_, event) => event % 3);
    const space = Uint8Array.from({ length: eventCount }, (_, event) => (event >> 3) & 1);
    const population = new Population(samples, new Uint32Array(eventCount).fill(1));

    return {
        population,
        lifespan,
        space,
        records: createRecords(population, classify([lifespan, space], eventCount))
    };
}

function assertEqualPopulations(actual: PopulationFiltered, expected: PopulationFiltered, step: string) {
    const cuts = (population: PopulationFiltered) => [...population.boundaryCuts]
        .sort((a, b) => a.index - b.index)
        .map(({ index, value }) => `${index}:${value}`);
    const reader = actual.eventReader();

    assert.deepEqual([...actual.samplesTotal], [...expected.samplesTotal], `${step}: totals`);
    assert.deepEqual([...actual.samplesCount], [...expected.samplesCount], `${step}: counts`);
    assert.deepEqual(actual.sink, expected.sink, `${step}: sink`);
    assert.equal(actual.rangeSamples, expected.rangeSamples, `${step}: rangeSamples`);
    assert.deepEqual(cuts(actual), cuts(expected), `${step}: boundary cuts`);

    for (let index = 0; index < expected.samples.length; index++) {
        assert.equal(reader.destination(index), expected.samples[index], `${step}: destination of ${index}`);
        assert.equal(reader.value(index), expected.values[index], `${step}: value of ${index}`);
    }

    assert.deepEqual(actual.samples, expected.samples, `${step}: destinations`);
    assert.deepEqual(actual.values, expected.values, `${step}: values`);
}

test.each([
    { name: 'empty', values: [], partEvents: [0], parts: [] },
    { name: 'events at grid points start their bins', values: [1, 1, 1, 1, 3996], partEvents: [0, 2, 4, 5], parts: [0, 0, 1, 1, 2] },
    { name: 'zero-sized events at the start join the first bin', values: [0, 0, 4, 4], partEvents: [0, 3, 4], parts: [0, 0, 0, 1] },
    { name: 'zero-sized events at the end join the last bin', values: [2, 2, 0, 0], partEvents: [0, 1, 2, 4], parts: [0, 1, 2, 2] },
    {
        name: 'every bin of equal events',
        values: Array(4000).fill(1),
        partEvents: Array.from({ length: 2001 }, (_, part) => 2 * part),
        parts: Array.from({ length: 4000 }, (_, event) => event >> 1)
    }
])('parts are the nonempty bins of a 2000-bin grid on the value axis: $name', ({ values, partEvents, parts }) => {
    const population = new Population(new Uint32Array(values.length), Uint32Array.from(values));

    const records = createRecords(population);

    assert.deepEqual([...records.partEvents], partEvents);
    assert.equal(records.partCount, partEvents.length - 1);
    assert.deepEqual(Array.from(values, (_, event) => records.partOf(event)), parts);
});

test('splits a bin of more than 65,536 events into parts of at most 65,536 events', () => {
    // All events start at coordinate 0, so the first bin holds every event
    const values = new Uint32Array(70_001);
    values[70_000] = 2000;
    const population = new Population(new Uint32Array(values.length), values);

    const records = createRecords(population);

    assert.deepEqual([...records.partEvents], [0, 65_536, 70_001]);
    assert.deepEqual([0, 65_535, 65_536, 70_000].map(event => records.partOf(event)), [0, 0, 1, 1]);
    assert.deepEqual(recordsOf(records), [
        { part: 0, sample: 0, eventClass: 0, weight: 0, count: 0 },
        { part: 1, sample: 0, eventClass: 0, weight: 2000, count: 1 }
    ]);
});

test('records sum values and nonzero counts of a part per sample and class', () => {
    // Bins are 8 wide: events 0-7 start before 8, event 8 at 8. Events 0-1 repeat a key, event 2 changes only
    // the class, event 3 only the sample, event 4 returns to the key of event 0
    const samples = Uint32Array.of(3, 3, 3, 1, 3, 1, 2, 2, 0);
    const classIds = Uint8Array.of(0, 0, 1, 0, 0, 0, 1, 1, 0);
    const values = Uint32Array.of(1, 0, 1, 1, 1, 1, 1, 2, 15_992);
    const population = new Population(samples, values);

    const records = createRecords(population, { ids: classIds, events: Uint32Array.of(0, 2), values: new Set() });

    assert.deepEqual([...records.partEvents], [0, 8, 9]);
    assert.deepEqual(recordsOf(records), [
        { part: 0, sample: 1, eventClass: 0, weight: 2, count: 2 },
        { part: 0, sample: 2, eventClass: 1, weight: 3, count: 2 },
        { part: 0, sample: 3, eventClass: 0, weight: 2, count: 2 },
        { part: 0, sample: 3, eventClass: 1, weight: 1, count: 1 },
        { part: 1, sample: 0, eventClass: 0, weight: 15_992, count: 1 }
    ]);
    assert.equal(records.keyCount, 5);
});

test('keeps one key per sample and class beyond the initial capacity of the key table', () => {
    // The table of 1024 slots grows after 513 keys; the next new key is sample 0 of class 0. Events 0-515 start
    // in the first bin and make a part with 514 keys; every later event is a part of its own, so repeated keys
    // and samples of another class are looked up in the grown table. Samples are multiples of 64, so their keys
    // share hash slots
    const samples = new Uint32Array(700);
    const classIds = new Uint8Array(700);
    const values = new Uint32Array(700).fill(6000, 515);

    values.fill(1, 0, 515);

    for (let event = 0; event < 513; event++) {
        samples[event] = (event + 1) * 64;
    }

    for (let event = 514; event < 600; event++) {
        samples[event] = (event - 513) * 64;
    }

    for (let event = 600; event < 700; event++) {
        samples[event] = (event - 599) * 64;
        classIds[event] = 1;
    }

    const expected = new Map<string, { weight: number; count: number }>();

    for (let event = 0; event < 700; event++) {
        const key = `${samples[event]}:${classIds[event]}`;
        const sums = expected.get(key) ?? { weight: 0, count: 0 };

        sums.weight += values[event];
        sums.count++;
        expected.set(key, sums);
    }

    const population = new Population(samples, values);

    const records = createRecords(population, { ids: classIds, events: Uint32Array.of(0, 600), values: new Set() });

    const actual = new Map<string, { weight: number; count: number }>();

    for (const { sample, eventClass, weight, count } of recordsOf(records)) {
        const key = `${sample}:${eventClass}`;
        const sums = actual.get(key) ?? { weight: 0, count: 0 };

        sums.weight += weight;
        sums.count += count;
        actual.set(key, sums);
    }

    assert.deepEqual([...records.partEvents.subarray(0, 3)], [0, 516, 517]);
    assert.equal(records.partCount, 185);
    assert.equal(records.keyCount, 614);
    assert.deepEqual([...actual].sort(), [...expected].sort());
});

test.each([
    { name: 'small values', scale: 1 },
    { name: 'record sums beyond 2^32', scale: 4_000_000 }
])('metrics from records equal event aggregation through filter, mask, range and constraint changes: $name', ({ scale }) => {
    const { population, lifespan, space, other, records } = createFixture(scale);
    const { cumulative } = population;
    const total = population.cumulativeEnd;
    const [viewport, expectedViewport] = [new PopulationFiltered(population), new PopulationFiltered(population)];
    const [selection, expectedSelection] = [new PopulationFiltered(viewport), new PopulationFiltered(expectedViewport)];
    const both = (update: (population: PopulationFiltered) => void) => {
        update(viewport);
        update(expectedViewport);
    };
    // A nonzero event inside a part, not its first one
    let inner = records.partEvents[records.partCount >> 1] + 1;

    while (population.values[inner] === 0 || records.partOf(inner) !== records.partOf(inner - 1)) {
        inner++;
    }

    const steps: [string, () => void][] = [
        ['initial', () => {}],
        ['lifespan filter', () => both(p => p.filter.set({ key: 'lifespan', domain: 'event', size: lifespan.length, values: lifespan, accepts: Uint8Array.of(1, 0, 1) }))],
        ['two event filters', () => both(p => p.filter.set({ key: 'space', domain: 'event', size: space.length, values: space, accepts: Uint8Array.of(1, 1, 0, 1, 0) }))],
        ['sample filter', () => both(p => p.filter.set({ key: 'sample', domain: 'sample', size: 50, accepts: Uint8Array.from({ length: 50 }, (_, sample) => sample % 7 === 0 ? 0 : 1) }))],
        ['raw mask', () => both(p => p.updateMask(mask => {
            mask[3] |= 0x80000000;
        }))],
        ['single range', () => both(p => p.setRange(total * 0.13 + 0.5, total * 0.71))],
        ['shifted range', () => both(p => p.setRange(total * 0.2 + 0.25, total * 0.78 + 0.5))],
        ['narrow range', () => both(p => p.setRange(total * 0.5, total * 0.5 + 3000))],
        ['multiple ranges', () => both(p => p.setRanges([
            { start: 1000.5, end: total * 0.3 },
            { start: total * 0.3 + 10, end: total * 0.6 },
            { start: total * 0.9, end: total }
        ]))],
        ['selection range', () => {
            selection.setRange(total * 0.25, total * 0.95);
            expectedSelection.setRange(total * 0.25, total * 0.95);
        }],
        ['interval inside a part before others', () => both(p => p.setRanges([
            { start: cumulative[inner] + 0.25, end: cumulative[inner] + 0.75 },
            { start: total * 0.6, end: total * 0.8 }
        ]))],
        ['value minimum', () => both(p => p.setValueRange(100 * scale, null))],
        ['value maximum', () => both(p => p.setValueRange(null, 500 * scale))],
        ['without value constraint', () => both(p => p.resetValueRange())],
        ['index start', () => both(p => p.setIndexRange(1000, null))],
        ['index end', () => both(p => p.setIndexRange(null, 7000))],
        ['without index constraint', () => both(p => p.resetIndexRange())],
        ['event filter over values of no class', () => both(p => p.filter.set({ key: 'other', domain: 'event', size: other.length, values: other, accepts: Uint8Array.of(0, 1) }))],
        ['without event filter over values of no class', () => both(p => p.filter.remove('other'))],
        ['empty ranges', () => both(p => p.setRanges([]))],
        ['reset mask', () => both(p => p.resetMask())],
        ['without filters', () => both(p => {
            p.filter.remove('lifespan');
            p.filter.remove('space');
            p.filter.remove('sample');
            p.resetRange();
        })],
        ['selection own event filter', () => {
            selection.filter.set({ key: 'own', domain: 'event', size: lifespan.length, values: lifespan, accepts: Uint8Array.of(0, 1, 1) });
            expectedSelection.filter.set({ key: 'own', domain: 'event', size: lifespan.length, values: lifespan, accepts: Uint8Array.of(0, 1, 1) });
        }]
    ];

    viewport.filter.setEventClasses(records.classes);
    viewport.setRecords(records);
    selection.setRecords(records);

    for (const [step, apply] of steps) {
        apply();
        assertEqualPopulations(viewport, expectedViewport, `viewport after ${step}`);
        assertEqualPopulations(selection, expectedSelection, `selection after ${step}`);
    }
});

test('metrics from records equal event aggregation for ranges with edges next to part boundaries', () => {
    const { population, records } = createFixture();
    const { cumulative, cumulativeEnd } = population;
    const random = sequence(5);
    const viewport = new PopulationFiltered(population);
    const expected = new PopulationFiltered(population);
    const coordinate = (part: number, offset: number) => {
        const event = Math.min(cumulative.length - 1, Math.max(0, records.partEvents[part] + offset));

        return cumulative[event];
    };

    viewport.filter.setEventClasses(records.classes);
    viewport.setRecords(records);

    for (let step = 0; step < 60; step++) {
        const startPart = random(records.partCount);
        const endPart = Math.min(records.partCount, startPart + random(40));
        const start = coordinate(startPart, random(3) - 1) + (random(2) === 0 ? 0 : 0.5);
        const end = Math.min(cumulativeEnd, Math.max(start, coordinate(endPart, random(3) - 1) + random(2)));

        viewport.setRange(start, end);
        expected.setRange(start, end);
        assertEqualPopulations(viewport, expected, `range ${start}..${end}`);
    }
});

test('ignores records of other events and returns to the event pass without records', () => {
    const { population, records } = createRegularFixture();
    const shifted = Uint32Array.from(population.samples, sample => (sample + 1) % 7);
    const otherRecords = new PopulationRecords(shifted, population.values, population.cumulative, population.cumulativeEnd, records.classes);
    const viewport = new PopulationFiltered(population);
    const expected = new PopulationFiltered(population);
    const sampleFilter = { key: 'sample', domain: 'sample' as const, size: 7, accepts: Uint8Array.of(1, 1, 1, 0, 1, 1, 1) };
    viewport.filter.set(sampleFilter);
    expected.filter.set(sampleFilter);

    viewport.setRecords(otherRecords);
    viewport.setRange(1005, 15_005);
    expected.setRange(1005, 15_005);

    assertEqualPopulations(viewport, expected, 'records of other events');

    viewport.setRecords(records);

    assertEqualPopulations(viewport, expected, 'own records');

    viewport.setRecords(null);
    viewport.setRange(2005, 12_005);
    expected.setRange(2005, 12_005);

    assertEqualPopulations(viewport, expected, 'without records');
});

test('a range change over records reads base values only at range edges and in the parts they cut', () => {
    const { population, lifespan, space, records } = createRegularFixture();
    const viewport = new PopulationFiltered(population);
    const expected = new PopulationFiltered(new Population(population.samples, population.values));
    // Two event filters are intersected per class
    const filters = [
        { key: 'lifespan', domain: 'event' as const, size: lifespan.length, values: lifespan, accepts: Uint8Array.of(1, 0, 1) },
        { key: 'space', domain: 'event' as const, size: space.length, values: space, accepts: Uint8Array.of(0, 1) }
    ];
    viewport.filter.setEventClasses(records.classes);
    viewport.setRecords(records);
    viewport.filter.batch(() => {
        for (const filter of filters) {
            viewport.filter.set(filter);
        }
    });
    for (const filter of filters) {
        expected.filter.set(filter);
    }
    const reads = countReads(population, 'values');

    // Parts hold 10 events: [1000, 15000) covers whole parts, [1005, 15005) cuts two of them
    viewport.setRange(1000, 15_000);
    expected.setRange(1000, 15_000);

    assert.ok(reads.count <= 4, `reads on the grid: ${reads.count}`);
    assertEqualPopulations(viewport, expected, 'range on the grid');

    reads.count = 0;
    viewport.setRange(1005, 15_005);
    expected.setRange(1005, 15_005);

    assert.ok(reads.count <= 4 + 2 * 2 * 10, `reads with edges inside parts: ${reads.count}`);
    assertEqualPopulations(viewport, expected, 'range with edges inside parts');
});

test('single-event readers derive destinations and values from records without compiling all events', () => {
    const { population, records } = createRegularFixture();
    const viewport = new PopulationFiltered(population);
    viewport.setRecords(records);
    const sampleReads = countReads(population, 'samples');
    const valueReads = countReads(population, 'values');
    const probes = [1004, 1005, 10_000, 15_004, 15_005];
    const readProbes = () => {
        const reader = viewport.eventReader();
        const destinations: number[] = [];
        const values: number[] = [];

        for (const event of probes) {
            destinations.push(reader.destination(event));
            values.push(reader.value(event));
        }

        return { destinations, values };
    };

    assert.deepEqual(readProbes(), { destinations: [3, 4, 4, 3, 4], values: [1, 1, 1, 1, 1] });
    assert.ok(sampleReads.count + valueReads.count <= 3 * probes.length, `reads: ${sampleReads.count + valueReads.count}`);

    viewport.filter.set({ key: 'sample', domain: 'sample', size: 7, accepts: Uint8Array.of(1, 1, 1, 0, 1, 1, 1) });
    viewport.setRange(1005, 15_005);
    sampleReads.count = 0;
    valueReads.count = 0;

    // Sample 3 goes to the sink 7; the range covers events 1005-15004
    assert.deepEqual(readProbes(), { destinations: [7, 4, 4, 7, 4], values: [0, 1, 1, 1, 0] });
    assert.ok(sampleReads.count + valueReads.count <= 3 * probes.length, `reads: ${sampleReads.count + valueReads.count}`);
});
