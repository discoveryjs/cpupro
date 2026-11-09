import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Population, PopulationFiltered } from './population.js';
import { PopulationRecords } from './population-records.js';

// Deterministic pseudo-random sequence
function sequence(seed: number) {
    return (max: number) => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;

        return (seed >>> 8) % max;
    };
}

// Several record chunks of events with runs of equal samples and classes, some zero values; scaled values sum
// beyond 2^32
function createFixture(scale = 1) {
    const random = sequence(11);
    const eventCount = 300_000;
    const samples = new Uint32Array(eventCount);
    const values = new Uint32Array(eventCount);
    const lifespan = new Uint8Array(eventCount);
    const space = new Uint32Array(eventCount);

    for (let event = 0, sample = 0; event < eventCount; event++) {
        sample = random(4) === 0 ? random(50) : sample;
        samples[event] = sample;
        values[event] = random(6) === 0 ? 0 : (1 + random(900)) * scale;
        lifespan[event] = random(3);
        space[event] = random(5);
    }

    const ids = Uint16Array.from(lifespan, (value, event) => value * 5 + space[event]);
    const events = new Uint32Array(15);

    for (let event = eventCount - 1; event >= 0; event--) {
        events[ids[event]] = event;
    }

    const population = new Population(samples, values, 50);
    const classes = { ids, events, values: new Set<Uint8Array | Uint16Array | Uint32Array>([lifespan, space]) };

    return {
        population,
        lifespan,
        space,
        records: new PopulationRecords(samples, values, population.cumulative, population.cumulativeEnd, classes)
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

    for (let index = 0; index < expected.samples.length; index += 997) {
        assert.equal(reader.destination(index), expected.samples[index], `${step}: destination of ${index}`);
        assert.equal(reader.value(index), expected.values[index], `${step}: value of ${index}`);
    }

    assert.deepEqual(actual.samples, expected.samples, `${step}: destinations`);
    assert.deepEqual(actual.values, expected.values, `${step}: values`);
}

test.each([1, 100_000])('metrics from records equal event aggregation through filter, mask, range and constraint changes, values scale %d', (scale) => {
    const { population, lifespan, space, records } = createFixture(scale);
    const total = population.cumulativeEnd;
    const [viewport, expectedViewport] = [new PopulationFiltered(population), new PopulationFiltered(population)];
    const [selection, expectedSelection] = [new PopulationFiltered(viewport), new PopulationFiltered(expectedViewport)];
    const both = (update: (population: PopulationFiltered, index: number) => void) => {
        update(viewport, 0);
        update(expectedViewport, 1);
    };
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
        ['value constraint', () => both(p => p.setValueRange(100, null))],
        ['without value constraint', () => both(p => p.resetValueRange())],
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

test('records group events of value grid parts by sample and class', () => {
    const { population, records } = createFixture();
    const { samples, values, cumulative, cumulativeEnd } = population;
    const { partEvents } = records;

    assert.equal(partEvents[0], 0);
    assert.equal(partEvents[records.partCount], samples.length);
    assert.ok(records.partCount > 1000);

    for (let part = 0; part < records.partCount; part++) {
        const first = partEvents[part];
        const end = partEvents[part + 1];
        let weight = 0;
        let recordWeight = 0;

        // A part is one bin of the grid, or a split of a bin with many events
        assert.ok(end > first && end - first <= 1 << 16);
        assert.ok(Math.floor(cumulative[end - 1] * 2000 / cumulativeEnd) - Math.floor(cumulative[first] * 2000 / cumulativeEnd) <= 1);
        assert.equal(records.partOf(first), part);
        assert.equal(records.partOf(end - 1), part);

        for (let event = first; event < end; event++) {
            weight += values[event];
        }

        for (let record = records.partStarts[part]; record < records.partStarts[part + 1]; record++) {
            recordWeight += records.recordWeights[record];
        }

        assert.equal(recordWeight, weight);
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

