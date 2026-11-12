import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Population, PopulationFiltered } from './population.js';
import { PopulationRecords } from './population-records.js';
import type { EventClasses } from './population-filter.js';
import type { PreparedAttributeFilter } from './attribute-filter.js';
import type { RangeSet } from './coordinates.js';
import { trackReads } from '../../../test/helpers/read-tracker.js';
import { setEventPass } from '../../../test/helpers/event-pass.js';
import { createUint32Progression } from '../misc/utils.js';

type EventValues = Uint8Array | Uint16Array | Uint32Array;
type RecordRow = [part: number, sample: number, eventClass: number, weight: number, count: number];
type Grouping = [Uint8Array | Uint32Array, number];

// Deterministic pseudo-random sequence
function sequence(seed: number) {
    return (max: number) => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;

        return (seed >>> 8) % max;
    };
}

// Classes of events with equal values of every vector, numbered in the order of their first events
function classify(vectors: EventValues[], eventCount: number): EventClasses & { ids: Uint32Array } {
    const ids = new Uint32Array(eventCount);
    const classIds = new Map<string, number>();
    const events: number[] = [];

    for (let i = 0; i < eventCount; i++) {
        const key = vectors.map(values => values[i]).join(',');
        let id = classIds.get(key);

        if (id === undefined) {
            id = events.push(i) - 1;
            classIds.set(key, id);
        }

        ids[i] = id;
    }

    return { ids, events: Uint32Array.from(events), values: new Set(vectors) };
}

function createRecords(population: Population, classes = classify([], population.values.length)) {
    return new PopulationRecords(
        population.samples,
        population.values,
        population.cumulative,
        population.cumulativeEnd,
        classes
    );
}

function createEventFilter(key: string, values: EventValues, accepts: Uint8Array): PreparedAttributeFilter {
    return {
        key,
        domain: 'event',
        size: values.length,
        values: values as Uint8Array | Uint32Array,
        accepts
    };
}

// Order of parts, then samples, then classes
function compareRecords(a: RecordRow, b: RecordRow) {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) {
            return a[i] - b[i];
        }
    }

    return 0;
}

// Records as rows of a part, a sample, a class, the sum of values and the nonzero count, in this order
function recordsOf(records: PopulationRecords) {
    const result: RecordRow[] = [];

    for (let i = 0; i < records.partCount; i++) {
        const end = records.partRecords[i + 1];

        for (let j = records.partRecords[i]; j < end; j++) {
            const { samples, classes, weights, counts } = records.blocks[Math.floor(j / records.blockSize)];
            const index = j % records.blockSize;

            result.push([
                i,
                samples[index],
                classes[index],
                weights[index],
                counts[index]
            ]);
        }
    }

    return result.sort(compareRecords);
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
    let sample = 0;

    for (let i = 0; i < eventCount; i++) {
        sample = random(4) === 0 ? random(50) : sample;
        samples[i] = sample;
        values[i] = random(6) === 0 ? 0 : (1 + random(900)) * scale;
        lifespan[i] = random(3);
        space[i] = random(5);
        other[i] = random(2);
    }

    const classes = classify([lifespan, space], eventCount);
    const population = new Population(samples, values, 50, undefined, classes);

    return {
        population,
        lifespan,
        space,
        other,
        classes,
        records: population.records
    };
}

// Events of value 1 and 7 samples in turn: the 2000-bin grid has parts of 10 events
function createRegularFixture() {
    const eventCount = 20_000;
    const samples = new Uint32Array(eventCount);
    const lifespan = new Uint8Array(eventCount);
    const space = new Uint8Array(eventCount);

    for (let i = 0; i < eventCount; i++) {
        samples[i] = i % 7;
        lifespan[i] = i % 3;
        space[i] = (i >> 3) & 1;
    }

    const classes = classify([lifespan, space], eventCount);
    const population = new Population(samples, new Uint32Array(eventCount).fill(1), undefined, undefined, classes);

    return {
        population,
        lifespan,
        space,
        records: population.records
    };
}

function cutsOf(population: PopulationFiltered) {
    const cuts: string[] = [];

    for (let i = 0; i < population.boundaryCuts.length; i++) {
        cuts.push(`${population.boundaryCuts[i].index}:${population.boundaryCuts[i].value}`);
    }

    return cuts.sort();
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

function assertEqualPopulations(
    actual: PopulationFiltered,
    expected: PopulationFiltered,
    step: string,
    groupings: Grouping[] = []
) {
    const reader = actual.eventReader();

    assert.deepEqual([...actual.samplesTotal], [...expected.samplesTotal], `${step}: totals`);
    assert.deepEqual([...actual.samplesCount], [...expected.samplesCount], `${step}: counts`);
    assert.deepEqual(valuedSamplesWithoutCount(actual), [], `${step}: values of samples without counted events`);
    assert.deepEqual(actual.sink, expected.sink, `${step}: sink`);
    assert.equal(actual.rangeSamples, expected.rangeSamples, `${step}: rangeSamples`);
    assert.deepEqual(cutsOf(actual), cutsOf(expected), `${step}: boundary cuts`);

    for (let i = 0; i < expected.samples.length; i++) {
        assert.equal(reader.destination(i), expected.samples[i], `${step}: destination of ${i}`);
        assert.equal(reader.value(i), expected.values[i], `${step}: value of ${i}`);
    }

    // Groupings constant within event classes come from records while the population computes from records
    for (let i = 0; i < groupings.length; i++) {
        const [groups, count] = groupings[i];

        assert.deepEqual(
            actual.aggregateBy(groups, count),
            expected.aggregateBy(groups, count),
            `${step}: aggregation by ${count} groups`
        );
    }

    assert.deepEqual(actual.samples, expected.samples, `${step}: destinations`);
    assert.deepEqual(actual.values, expected.values, `${step}: values`);
}

test.each([
    {
        name: 'empty',
        values: [],
        partEvents: [0],
        parts: []
    },
    {
        name: 'events at grid points start their bins',
        values: [1, 1, 1, 1, 3996],
        partEvents: [0, 2, 4, 5],
        parts: [0, 0, 1, 1, 2]
    },
    {
        name: 'zero-sized events at the start join the first bin',
        values: [0, 0, 4, 4],
        partEvents: [0, 3, 4],
        parts: [0, 0, 0, 1]
    },
    {
        name: 'zero-sized events at the end join the last bin',
        values: [2, 2, 0, 0],
        partEvents: [0, 1, 2, 4],
        parts: [0, 1, 2, 2]
    },
    {
        name: 'every bin of equal events',
        values: Array(4000).fill(1),
        partEvents: Array.from({ length: 2001 }, (_, i) => 2 * i),
        parts: Array.from({ length: 4000 }, (_, i) => i >> 1)
    }
])('parts are the nonempty bins of a 2000-bin grid on the value axis: $name', row => {
    const population = new Population(new Uint32Array(row.values.length), Uint32Array.from(row.values));
    const parts: number[] = [];

    const records = createRecords(population);

    for (let i = 0; i < row.values.length; i++) {
        parts.push(records.partOf(i));
    }

    assert.deepEqual([...records.partEvents], row.partEvents);
    assert.equal(records.partCount, row.partEvents.length - 1);
    assert.deepEqual(parts, row.parts);
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
        [0, 0, 0, 0, 0],
        [1, 0, 0, 2000, 1]
    ]);
});

// Every event is a sample of its own, so every event is a record and records of 1.1M events fill more than a block
// of 1M records; ranges and a sample filter cross the end of the first block
test('metrics from records equal event aggregation across blocks of records', () => {
    const eventCount = 1_100_000;
    const population = new Population(createUint32Progression(eventCount), new Uint32Array(eventCount).fill(1));
    const viewport = new PopulationFiltered(population);
    const expected = new PopulationFiltered(population);
    const accepts = Uint8Array.from({ length: eventCount }, (_, sample) => sample % 3 === 0 ? 0 : 1);
    const filter: PreparedAttributeFilter = { key: 'sample', domain: 'sample', size: eventCount, accepts };

    setEventPass(expected);
    viewport.filter.set(filter);
    expected.filter.set(filter);
    const rangeSets: RangeSet[] = [
        [{ start: 1_000_000, end: 1_060_000 }],
        [{ start: 0, end: 500_000 }, { start: 900_000, end: 1_100_000 }]
    ];

    assert.ok(population.records.blocks.length > 1);

    for (let i = 0; i < rangeSets.length; i++) {
        viewport.setRanges(rangeSets[i]);
        expected.setRanges(rangeSets[i]);

        assert.deepEqual(viewport.samplesTotal, expected.samplesTotal);
        assert.deepEqual(viewport.samplesCount, expected.samplesCount);
        assert.deepEqual(viewport.sink, expected.sink);
        assert.equal(viewport.countAccepted([[0, eventCount]]), expected.countAccepted([[0, eventCount]]));
    }
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
        [0, 1, 0, 2, 2],
        [0, 2, 1, 3, 2],
        [0, 3, 0, 2, 2],
        [0, 3, 1, 1, 1],
        [1, 0, 0, 15_992, 1]
    ]);
    assert.deepEqual([...records.partCounts], [7, 1]);
});

test('finds records of a part among slots that keep records of earlier parts', () => {
    // Events 0-515 start in the first bin and make a part of 514 records: samples 64, 128, ..., 32832 of events
    // 0-512, sample 0 of event 513, and events 514 and 515 repeat samples 64 and 128. Every later event is a part
    // of its own, so its sample and class are looked up in slots that keep records of the first part, and
    // samples of another class follow. Samples are multiples of 64, so their records share hash slots
    const samples = new Uint32Array(700);
    const classIds = new Uint8Array(700);
    const values = new Uint32Array(700).fill(6000, 515);

    values.fill(1, 0, 515);

    for (let i = 0; i < 513; i++) {
        samples[i] = (i + 1) * 64;
    }

    for (let i = 514; i < 600; i++) {
        samples[i] = (i - 513) * 64;
    }

    for (let i = 600; i < 700; i++) {
        samples[i] = (i - 599) * 64;
        classIds[i] = 1;
    }

    const population = new Population(samples, values);

    const records = createRecords(population, { ids: classIds, events: Uint32Array.of(0, 600), values: new Set() });
    const result = recordsOf(records);

    assert.deepEqual([...records.partEvents.subarray(0, 3)], [0, 516, 517]);
    assert.equal(records.partCount, 185);
    assert.equal(result.length, 514 + 184);
    assert.deepEqual(result.slice(0, 4), [
        [0, 0, 0, 1, 1],
        [0, 64, 0, 2, 2],
        [0, 128, 0, 6001, 2],
        [0, 192, 0, 1, 1]
    ]);
    assert.deepEqual(result[513], [0, 32_832, 0, 1, 1]);

    // Every later record is the record of a single event: record i of event i + 2, in part i - 513
    for (let i = 514; i < result.length; i++) {
        const event = i + 2;

        assert.deepEqual(result[i], [i - 513, samples[event], classIds[event], values[event], 1]);
    }
});

test.each([
    { name: 'small values', scale: 1 },
    { name: 'record sums beyond 2^32', scale: 4_000_000 }
])('metrics from records equal event aggregation through filter and range changes: $name', row => {
    const { population, lifespan, space, other, classes, records } = createFixture(row.scale);
    const { cumulative } = population;
    const total = population.cumulativeEnd;
    const viewport = new PopulationFiltered(population);
    const expectedViewport = new PopulationFiltered(population);
    const selection = new PopulationFiltered(viewport);
    const expectedSelection = new PopulationFiltered(expectedViewport);
    const populations = {
        viewport: [viewport, expectedViewport],
        selection: [selection, expectedSelection]
    };
    const groupings: Grouping[] = [
        [lifespan, 3],
        [space, 5],
        [classes.ids, 15]
    ];
    const lifespanFilter = createEventFilter('lifespan', lifespan, Uint8Array.of(1, 0, 1));
    const spaceFilter = createEventFilter('space', space, Uint8Array.of(1, 1, 0, 1, 0));
    const otherFilter = createEventFilter('other', other, Uint8Array.of(0, 1));
    const ownFilter = createEventFilter('own', lifespan, Uint8Array.of(0, 1, 1));
    const sampleFilter: PreparedAttributeFilter = {
        key: 'sample',
        domain: 'sample',
        size: 50,
        accepts: Uint8Array.from({ length: 50 }, (_, i) => Number(i % 7 !== 0))
    };
    // Samples and event classes flip together while parts are covered
    const flipSamplesAndClasses = (target: PopulationFiltered) => target.filter.batch(() => {
        target.filter.set({
            ...sampleFilter,
            accepts: Uint8Array.from({ length: 50 }, (_, i) => Number(i % 3 !== 0))
        });
        target.filter.set({ ...lifespanFilter, accepts: Uint8Array.of(0, 1, 1) });
    });
    const removeFiltersAndRanges = (target: PopulationFiltered) => {
        target.filter.remove('lifespan');
        target.filter.remove('space');
        target.filter.remove('sample');
        target.resetRange();
    };
    // A nonzero event inside a part, not its first one
    let inner = records.partEvents[records.partCount >> 1] + 1;

    while (population.values[inner] === 0 || records.partOf(inner) !== records.partOf(inner - 1)) {
        inner++;
    }

    const multipleRanges: RangeSet = [
        { start: 1000.5, end: total * 0.3 },
        { start: total * 0.3 + 10, end: total * 0.6 },
        { start: total * 0.9, end: total }
    ];
    const rangeInsidePart: RangeSet = [
        { start: cumulative[inner] + 0.25, end: cumulative[inner] + 0.75 },
        { start: total * 0.6, end: total * 0.8 }
    ];
    const steps: {
        name: string; target: 'viewport' | 'selection'; change: (target: PopulationFiltered) => void
    }[] = [
        {
            name: 'initial',
            target: 'viewport',
            change: () => {}
        },
        {
            name: 'lifespan filter',
            target: 'viewport',
            change: target => target.filter.set(lifespanFilter)
        },
        {
            name: 'two event filters',
            target: 'viewport',
            change: target => target.filter.set(spaceFilter)
        },
        {
            name: 'sample filter',
            target: 'viewport',
            change: target => target.filter.set(sampleFilter)
        },
        {
            name: 'sample and event filters together',
            target: 'viewport',
            change: flipSamplesAndClasses
        },
        {
            name: 'single range',
            target: 'viewport',
            change: target => target.setRange(total * 0.13 + 0.5, total * 0.71)
        },
        {
            name: 'shifted range',
            target: 'viewport',
            change: target => target.setRange(total * 0.2 + 0.25, total * 0.78 + 0.5)
        },
        {
            name: 'narrow range',
            target: 'viewport',
            change: target => target.setRange(total * 0.5, total * 0.5 + 3000)
        },
        {
            name: 'multiple ranges',
            target: 'viewport',
            change: target => target.setRanges(multipleRanges)
        },
        {
            name: 'selection range',
            target: 'selection',
            change: target => target.setRange(total * 0.25, total * 0.95)
        },
        {
            name: 'interval inside a part before others',
            target: 'viewport',
            change: target => target.setRanges(rangeInsidePart)
        },
        {
            name: 'event filter over values of no class',
            target: 'viewport',
            change: target => target.filter.set(otherFilter)
        },
        {
            name: 'without event filter over values of no class',
            target: 'viewport',
            change: target => target.filter.remove('other')
        },
        {
            name: 'empty ranges',
            target: 'viewport',
            change: target => target.setRanges([])
        },
        {
            name: 'without filters and ranges',
            target: 'viewport',
            change: removeFiltersAndRanges
        },
        {
            name: 'selection own event filter',
            target: 'selection',
            change: target => target.filter.set(ownFilter)
        }
    ];

    setEventPass(expectedViewport);

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const targets = populations[step.target];

        step.change(targets[0]);
        step.change(targets[1]);
        assertEqualPopulations(viewport, expectedViewport, `viewport after ${step.name}`, groupings);
        assertEqualPopulations(selection, expectedSelection, `selection after ${step.name}`, groupings);
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

    setEventPass(expected);

    for (let i = 0; i < 60; i++) {
        const startPart = random(records.partCount);
        const endPart = Math.min(records.partCount, startPart + random(40));
        const start = coordinate(startPart, random(3) - 1) + random(2) / 2;
        const end = Math.min(cumulativeEnd, Math.max(start, coordinate(endPart, random(3) - 1) + random(2)));

        viewport.setRange(start, end);
        expected.setRange(start, end);
        assertEqualPopulations(viewport, expected, `range ${start}..${end}`);
    }
});

test('a range change over records reads base values only at range edges and in the parts they cut', () => {
    const { population, lifespan, space } = createRegularFixture();
    const viewport = new PopulationFiltered(population);
    const expected = new PopulationFiltered(new Population(population.samples, population.values));
    // Two event filters are intersected per class
    const lifespanFilter = createEventFilter('lifespan', lifespan, Uint8Array.of(1, 0, 1));
    const spaceFilter = createEventFilter('space', space, Uint8Array.of(0, 1));
    viewport.filter.batch(() => {
        viewport.filter.set(lifespanFilter);
        viewport.filter.set(spaceFilter);
    });
    expected.filter.set(lifespanFilter);
    expected.filter.set(spaceFilter);
    const values = trackReads(population.values);
    population.values = values.array;

    // Parts hold 10 events: [1000, 15000) covers whole parts, [1005, 15005) cuts two of them
    viewport.setRange(1000, 15_000);
    expected.setRange(1000, 15_000);

    assert.ok(values.reads.length <= 4, `reads on the grid: ${values.reads.length}`);
    assertEqualPopulations(viewport, expected, 'range on the grid');

    values.reads.length = 0;
    viewport.setRange(1005, 15_005);
    expected.setRange(1005, 15_005);

    assert.ok(values.reads.length <= 4 + 2 * 2 * 10, `reads with edges inside parts: ${values.reads.length}`);
    assertEqualPopulations(viewport, expected, 'range with edges inside parts');
});

test('a base population sums groupings of event classes from its class sums without reading events', () => {
    const { population, lifespan, space, other, classes } = createFixture();
    // Events of a single class: groupings take a pass over the events
    const expected = new Population(population.samples, population.values, 50, population.cumulative);
    const samples = trackReads(population.samples);
    const values = trackReads(population.values);
    const groupings: Grouping[] = [[lifespan, 3], [space, 5], [classes.ids, classes.events.length]];
    population.samples = samples.array;
    population.values = values.array;

    for (let i = 0; i < groupings.length; i++) {
        const [groups, count] = groupings[i];

        assert.deepEqual(
            population.aggregateBy(groups, count),
            expected.aggregateBy(groups, count),
            `${count} groups`
        );
    }

    assert.equal(samples.reads.length + values.reads.length, 0);

    // Other groupings take a pass over the events
    assert.deepEqual(population.aggregateBy(other, 2), expected.aggregateBy(other, 2));
});

test('single-event readers derive destinations and values from records without compiling all events', () => {
    const { population } = createRegularFixture();
    const viewport = new PopulationFiltered(population);
    const samples = trackReads(population.samples);
    const values = trackReads(population.values);
    population.samples = samples.array;
    population.values = values.array;
    const probes = [1004, 1005, 10_000, 15_004, 15_005];
    const readProbes = () => {
        const reader = viewport.eventReader();
        const destinations: number[] = [];
        const probeValues: number[] = [];

        for (let i = 0; i < probes.length; i++) {
            destinations.push(reader.destination(probes[i]));
            probeValues.push(reader.value(probes[i]));
        }

        return { destinations, values: probeValues };
    };

    assert.deepEqual(readProbes(), { destinations: [3, 4, 4, 3, 4], values: [1, 1, 1, 1, 1] });
    assert.ok(samples.reads.length + values.reads.length <= 3 * probes.length);

    viewport.filter.set({
        key: 'sample',
        domain: 'sample',
        size: 7,
        accepts: Uint8Array.of(1, 1, 1, 0, 1, 1, 1)
    });
    viewport.setRange(1005, 15_005);
    samples.reads.length = 0;
    values.reads.length = 0;

    // Sample 3 goes to the sink 7; the range covers events 1005-15004
    assert.deepEqual(readProbes(), { destinations: [7, 4, 4, 7, 4], values: [0, 1, 1, 1, 0] });
    assert.ok(samples.reads.length + values.reads.length <= 3 * probes.length);
});

// Two parts of 65 events of zero values but the last one, classes alternate. The second part is grouped by class
// within runs of one sample when the first part has long runs, then sample 5 recurring after sample 6 takes records
// of its own; otherwise records are by sample and class in the part. Rows are ordered by part, sample and class.
test.each([
    {
        name: 'long runs',
        firstPartSamples: () => 3,
        rows: [
            [0, 3, 0, 1, 1],
            [0, 3, 1, 0, 0],
            [1, 5, 0, 0, 0],
            [1, 5, 0, 0, 0],
            [1, 5, 1, 0, 0],
            [1, 5, 1, 1, 1],
            [1, 6, 1, 0, 0]
        ]
    },
    {
        name: 'short runs',
        firstPartSamples: (i: number) => 3 + i % 2,
        rows: [
            [0, 3, 0, 1, 1],
            [0, 4, 1, 0, 0],
            [1, 5, 0, 0, 0],
            [1, 5, 1, 1, 1],
            [1, 6, 1, 0, 0]
        ]
    }
])('groups a part by class within runs of one sample after a part of $name', row => {
    const samples = new Uint32Array(130);
    const values = new Uint32Array(130);

    for (let i = 0; i < 65; i++) {
        samples[i] = row.firstPartSamples(i);
    }

    for (let i = 65; i < 130; i++) {
        samples[i] = i === 97 ? 6 : 5;
    }

    values[64] = 1;
    values[129] = 1;

    const population = new Population(samples, values);
    const classes = classify([Uint32Array.from(values, (_, i) => i % 2)], values.length);

    assert.deepEqual(recordsOf(createRecords(population, classes)), row.rows);
});
