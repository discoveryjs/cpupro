import assert from 'node:assert/strict';
import { describe, inject, test } from 'vitest';
import { Population, PopulationFiltered } from './population.js';
import { trackReads } from '../../../test/helpers/read-tracker.js';

describe('Population', () => {
    test('aggregates values and nonzero event counts by sample ID', () => {
        const samples = new Uint32Array([7, 0, 7, 2]);
        const values = new Uint32Array([16, 0, 32, 8]);
        const population = new Population(samples, values);
        assert.equal(population.samples, samples);
        assert.equal(population.values, values);
        assert.deepEqual([...population.cumulative], [0, 16, 16, 48]);
        assert.equal(population.cumulativeEnd, 56);
        assert.deepEqual([...population.samplesCount], [0, 0, 1, 0, 0, 0, 0, 2]);
        assert.deepEqual([...population.samplesTotal], [0, 0, 8, 0, 0, 0, 0, 48]);
    });

    test.each([
        { values: [], end: 0 },
        { values: [0, 0], end: 0 },
        { values: [10, 20, 0], end: 30 },
        { values: [10, 20, 30], end: 60 }
    ])('keeps the base cumulative endpoint under filtered constraints: $values', row => {
        const { values, end } = row;
        const population = new Population(new Uint32Array(values.length), Uint32Array.from(values));
        const filtered = new PopulationFiltered(population);
        assert.equal(population.cumulativeEnd, end);
        filtered.setRange(5, end + 10);
        filtered.filter.set({
            key: 'samples',
            domain: 'sample',
            size: 1,
            accepts: Uint8Array.of(0)
        });
        assert.equal(population.cumulativeEnd, end);
        assert.deepEqual([...population.values], values);
        filtered.resetRange();
        filtered.filter.remove('samples');
        assert.equal(population.cumulativeEnd, end);
    });

    test('events of selected groups are those the groups count, in order', () => {
        // Sample 2 is the sink, event 4 has a zero value
        const samples = new Uint32Array([0, 2, 1, 2, 0, 1, 1, 0]);
        const values = new Uint32Array([16, 12, 32, 48, 0, 8, 24, 4]);
        const groups = Uint8Array.of(1, 1, 2, 0, 2, 2, 1, 0);
        const population = new Population(samples, values, 2);

        assert.deepEqual(population.groupEvents(groups, 3, [2, 1]), [Uint32Array.of(2, 5), Uint32Array.of(0, 6)]);
    });
});

describe('PopulationFiltered', () => {
    test('attribute aggregation skips gaps and counts shared boundary events once', () => {
        const population = new Population(new Uint32Array(100_000), new Uint32Array(100_000).fill(10));
        const filtered = new PopulationFiltered(population);
        filtered.setRanges([{ start: 101, end: 102 }, { start: 105, end: 106 }, { start: 900_001, end: 900_003 }]);
        const values = trackReads(filtered.values);
        Object.defineProperty(filtered, 'values', { value: values.array });

        const result = filtered.aggregateBy(new Uint8Array(population.values.length), 1);

        assert.deepEqual([...result.samplesTotal], [4]);
        assert.deepEqual([...result.samplesCount], [2]);
        // Each edge event once for its value and once for its cut
        assert.deepEqual(values.reads.sort((a, b) => a - b), [10, 10, 90_000, 90_000]);
        filtered.destroy();
    });

    test('aggregates by row-aligned IDs with the existing filter and boundary semantics', () => {
        const population = new Population(new Uint32Array([0, 1, 0]), new Uint32Array([16, 32, 48]));
        const groups = new Uint32Array([1, 1, 2]);
        const viewport = new PopulationFiltered(population);
        const filtered = new PopulationFiltered(viewport);
        const destinations = filtered.samples;
        const values = filtered.values;

        assert.deepEqual(population.aggregateBy(groups, 3), {
            samplesCount: new Uint32Array([0, 2, 1]),
            samplesTotal: new Float64Array([0, 48, 48])
        });

        const verify = (counts: number[], totals: number[]) => {
            const metrics = filtered.aggregateBy(groups, 3);
            assert.deepEqual([...metrics.samplesCount], counts);
            assert.deepEqual([...metrics.samplesTotal], totals);
            assert.equal(filtered.samples, destinations);
            assert.equal(filtered.values, values);
            assert.deepEqual(filtered.aggregateBy(filtered.samples, filtered.samplesCount.length), {
                samplesCount: filtered.samplesCount,
                samplesTotal: filtered.samplesTotal
            });
        };

        filtered.setRanges([{ start: 1, end: 1.4 }, { start: 8, end: 8.4 }]);
        verify([0, 0, 0], [0, 0, 0]);
        filtered.setRanges([{ start: 1, end: 1.6 }, { start: 8, end: 8.6 }, { start: 20, end: 24 }]);
        verify([0, 2, 0], [0, 5, 0]);
        filtered.filter.set({
            key: 'samples',
            domain: 'sample',
            size: 2,
            accepts: Uint8Array.of(1, 0)
        });
        verify([0, 1, 0], [0, 1, 0]);
        filtered.filter.remove('samples');
        filtered.resetRange();
        viewport.setRange(5, 40);
        filtered.setRange(10, 24);
        verify([0, 2, 0], [0, 14, 0]);
        filtered.filter.set({
            key: 'row',
            domain: 'event',
            size: 3,
            accepts: Uint8Array.of(1, 0, 1)
        });
        verify([0, 1, 0], [0, 6, 0]);
        filtered.destroy();
        viewport.destroy();
    });

    test('moves and resets ranges without evaluating event acceptance or rebuilding sample destinations', () => {
        const population = new Population(new Uint32Array([0, 1, 0, 2, 1]), new Uint32Array([10, 0, 20, 30, 0]));
        const filtered = new PopulationFiltered(population);
        const predicate = {
            key: 'event',
            domain: 'event' as const,
            size: population.values.length,
            accepts: Uint8Array.of(1, 0, 1, 0, 1)
        };
        // Events of 10, 0, 20, 30 and 0 start at 0, 10, 10, 30 and 60
        const steps = [
            { start: 5, end: 35, values: [10, 0, 20, 30, 0] },
            { start: 35, end: 55, values: [0, 0, 0, 30, 0] },
            { start: 10, end: 10, values: [0, 0, 0, 0, 0] },
            { start: 0, end: 60, values: [10, 0, 20, 30, 0] },
            { start: 0.5, end: 30.5, values: [10, 0, 20, 30, 0] }
        ];
        filtered.filter.set(predicate);
        const destinations = filtered.samples.slice();
        let filterUpdates = 0;
        filtered.filter.subscribe(() => filterUpdates++);

        for (let i = 0; i < steps.length; i++) {
            filtered.setRange(steps[i].start, steps[i].end);
            assert.deepEqual([...filtered.values], steps[i].values);
            assert.deepEqual(filtered.samples, destinations);
        }

        filtered.resetRange();
        assert.deepEqual(filtered.values, population.values);
        assert.deepEqual(filtered.samples, destinations);
        assert.equal(filtered.filter.get('event'), predicate);
        assert.equal(filterUpdates, 0);
    });

    // Events of 10, 20 and 30 at [0, 10), [10, 30) and [30, 60), of samples 0, 1 and 2, between zero-sized events
    test.each([
        {
            start: 0,
            end: 10,
            values: [0, 10, 0, 0, 0, 0, 0],
            totals: [10, 0, 0],
            counts: [1, 0, 0],
            rangeSamples: 1
        },
        {
            start: 10,
            end: 30,
            values: [0, 0, 0, 20, 0, 0, 0],
            totals: [0, 20, 0],
            counts: [0, 1, 0],
            rangeSamples: 1
        },
        {
            start: 5,
            end: 35,
            values: [0, 10, 0, 20, 0, 30, 0],
            totals: [5, 20, 5],
            counts: [1, 1, 1],
            rangeSamples: 3
        },
        {
            start: 10,
            end: 10,
            values: [0, 0, 0, 0, 0, 0, 0],
            totals: [0, 0, 0],
            counts: [0, 0, 0],
            rangeSamples: 0
        },
        {
            start: -10,
            end: 100,
            values: [0, 10, 0, 20, 0, 30, 0],
            totals: [10, 20, 30],
            counts: [1, 1, 1],
            rangeSamples: 3
        },
        {
            start: 60,
            end: 80,
            values: [0, 0, 0, 0, 0, 0, 0],
            totals: [0, 0, 0],
            counts: [0, 0, 0],
            rangeSamples: 0
        }
    ])('clips half-open ranges with zero-sized events: [$start, $end)', row => {
        const samples = new Uint32Array([0, 0, 0, 1, 1, 2, 2]);
        const population = new Population(samples, new Uint32Array([0, 10, 0, 20, 0, 30, 0]));
        const filtered = new PopulationFiltered(population);
        filtered.setRange(row.start, row.end);
        assert.deepEqual([...filtered.values], row.values);
        assert.deepEqual([...filtered.samplesTotal], row.totals);
        assert.deepEqual([...filtered.samplesCount], row.counts);
        assert.equal(filtered.rangeSamples, row.rangeSamples);
        assert.deepEqual([...population.values], [0, 10, 0, 20, 0, 30, 0]);
    });

    test('suppresses identical range updates and rejects reversed ranges', () => {
        const population = new Population(new Uint32Array([0, 1, 0]), new Uint32Array([10, 20, 30]));
        const filtered = new PopulationFiltered(population);
        let updates = 0;
        filtered.subscribe(() => updates++);
        filtered.setRange(0, 60);
        filtered.setRange(0, 60);
        assert.equal(updates, 1);
        filtered.resetRange();
        filtered.resetRange();
        assert.equal(updates, 2);
        assert.throws(() => filtered.setRange(20, 10), RangeError);
        assert.deepEqual([...filtered.values], [10, 20, 30]);
    });

    test.each([
        { start: null, end: 25 },
        { start: 5, end: null }
    ])('resets the coordinate range by a null endpoint: [$start, $end)', row => {
        const population = new Population(new Uint32Array([0, 1]), new Uint32Array([10, 20]));
        const filtered = new PopulationFiltered(population);
        filtered.setRange(5, 25);

        filtered.setRange(row.start, row.end);

        assert.equal(filtered.ranges, null);
        assert.equal(filtered.rangeSamples, null);
        assert.deepEqual(filtered.values, population.values);
        assert.deepEqual(filtered.samplesTotal, population.samplesTotal);
    });

    test('reads single events of compiled destinations and values without records', () => {
        const population = new Population(new Uint32Array([0, 1, 0, 1]), new Uint32Array([10, 20, 30, 40]));
        const filtered = new PopulationFiltered(population);
        const readEvents = () => {
            const reader = filtered.eventReader();
            const destinations: number[] = [];
            const values: number[] = [];

            for (let i = 0; i < population.values.length; i++) {
                destinations.push(reader.destination(i));
                values.push(reader.value(i));
            }

            return { destinations, values };
        };

        assert.deepEqual(readEvents(), { destinations: [0, 1, 0, 1], values: [10, 20, 30, 40] });

        filtered.filter.set({
            key: 'samples',
            domain: 'sample',
            size: 2,
            accepts: Uint8Array.of(1, 0)
        });
        filtered.setRange(15, 65);

        assert.deepEqual(readEvents(), { destinations: [0, 2, 0, 2], values: [0, 20, 30, 40] });
    });

    test('produces the same result for every order of filters, ranges and their resets', () => {
        const population = new Population(new Uint32Array([0, 1, 0, 2]), new Uint32Array([10, 20, 30, 40]));
        const setFilter = (filtered: PopulationFiltered) => filtered.filter.set({
            key: 'samples',
            domain: 'sample',
            size: 3,
            accepts: Uint8Array.of(0, 1, 1)
        });
        const removeFilter = (filtered: PopulationFiltered) => filtered.filter.remove('samples');
        const setRange = (filtered: PopulationFiltered) => filtered.setRange(15, 65);
        const resetRange = (filtered: PopulationFiltered) => filtered.resetRange();
        const changes = [
            { apply: setFilter, reset: removeFilter },
            { apply: setRange, reset: resetRange }
        ];
        const orders = [[0, 1], [1, 0]];

        for (let i = 0; i < orders.length; i++) {
            for (let j = 0; j < orders.length; j++) {
                const filtered = new PopulationFiltered(population);
                const order = orders[i];
                const resetOrder = orders[j];

                for (let k = 0; k < order.length; k++) {
                    changes[order[k]].apply(filtered);
                }
                assert.deepEqual([...filtered.values], [0, 20, 30, 40]);
                assert.deepEqual([...filtered.samplesTotal], [0, 15, 5]);
                assert.deepEqual([...filtered.samplesCount], [0, 1, 1]);
                assert.deepEqual(filtered.sink, { count: 1, total: 30 });
                for (let k = 0; k < resetOrder.length; k++) {
                    changes[resetOrder[k]].reset(filtered);
                }
                assert.deepEqual(filtered.values, population.values);
                assert.deepEqual(filtered.samples, population.samples);
                assert.deepEqual(filtered.samplesTotal, population.samplesTotal);
                assert.deepEqual(filtered.samplesCount, population.samplesCount);
                assert.deepEqual(filtered.sink, { count: 0, total: 0 });
            }
        }
    });

    test('keeps an empty population empty under filters and ranges', () => {
        const filtered = new PopulationFiltered(new Population(new Uint32Array(), new Uint32Array()));
        filtered.filter.set({
            key: 'samples',
            domain: 'sample',
            size: 1,
            accepts: Uint8Array.of(0)
        });
        filtered.setRange(0, 10);
        assert.equal(filtered.values.length, 0);
        assert.equal(filtered.rangeSamples, 0);
        assert.deepEqual(filtered.sink, { count: 0, total: 0 });
        filtered.resetRange();
        filtered.filter.remove('samples');
        assert.deepEqual(filtered.samplesTotal, filtered.population.samplesTotal);
    });

    test('masks buckets, including bucket zero, and keeps sink outside public aggregates', () => {
        const population = new Population(new Uint32Array([0, 2, 0, 2, 0]), new Uint32Array([10, 20, 30, 0, 40]));
        const filtered = new PopulationFiltered(population);
        const counts = filtered.samplesCount;
        const totals = filtered.samplesTotal;
        const rejectFirst = { domain: 'sample' as const, size: 3, accepts: Uint8Array.of(0, 1, 1) };
        assert.equal(filtered.samplesMask.length, 3);
        assert.equal(filtered.sinkId, 3);
        assert.deepEqual(filtered.sink, { count: 0, total: 0 });

        let notifications = 0;
        filtered.subscribe(() => notifications++);
        filtered.filter.set({
            key: 'first',
            ...rejectFirst
        });
        assert.equal(notifications, 1);
        assert.deepEqual([...filtered.samples], [3, 2, 3, 2, 3]);
        // Metrics are read through the population and keep their arrays
        assert.equal(filtered.samplesTotal, totals);
        assert.equal(filtered.samplesCount, counts);
        assert.deepEqual([...totals], [0, 0, 20]);
        assert.deepEqual([...counts], [0, 0, 1]);
        assert.deepEqual(filtered.sink, { count: 3, total: 80 });
        assert.deepEqual(filtered.values, population.values);
        assert.deepEqual([...population.samples], [0, 2, 0, 2, 0]);

        // Another filter rejecting the same sample changes no destination
        filtered.filter.set({
            key: 'second',
            ...rejectFirst
        });
        filtered.filter.remove('first');
        assert.equal(notifications, 1);
        filtered.filter.remove('second');
        assert.equal(notifications, 2);
        assert.deepEqual(filtered.samples, population.samples);
        assert.deepEqual(filtered.samplesTotal, population.samplesTotal);
        assert.deepEqual(filtered.sink, { count: 0, total: 0 });

        filtered.filter.set({
            key: 'all',
            domain: 'sample',
            size: 3,
            accepts: new Uint8Array(3)
        });
        assert.deepEqual([...filtered.samplesTotal], [0, 0, 0]);
        assert.deepEqual(filtered.sink, { count: 4, total: 100 });
        filtered.filter.remove('all');
        assert.equal(notifications, 4);
        assert.equal(filtered.samplesCount, counts);
        assert.equal(filtered.samplesTotal, totals);
        assert.deepEqual(totals, population.samplesTotal);
    });

    const cases = [
        {
            name: 'empty',
            samples: [],
            values: []
        },
        {
            name: 'zero weights',
            samples: [0, 2, 2],
            values: [0, 0, 0]
        },
        {
            name: 'sparse IDs',
            samples: [7, 0, 7, 2],
            values: [16, 0, 32, 8]
        },
        {
            name: 'uint32 overflow',
            samples: [1, 1, 4],
            values: [0xffffffff, 2, 0]
        }
    ];

    test.each(cases)('copies initial aggregates into independent buffers: $name', row => {
        const population = new Population(Uint32Array.from(row.samples), Uint32Array.from(row.values));
        const filtered = new PopulationFiltered(population);
        assert.equal(filtered.buffer.memory instanceof WebAssembly.Memory, inject('useWasm'));
        assert.equal(filtered.cumulative, population.cumulative);
        for (const key of ['samples', 'values', 'samplesCount', 'samplesTotal'] as const) {
            assert.deepEqual(filtered[key], population[key]);
            assert.notEqual(filtered[key].buffer, population[key].buffer);
        }
        for (const key of ['samples', 'values'] as const) {
            assert.equal(filtered[key].buffer, filtered.buffer.memory!.buffer);
        }
        const originalTotals = population.samplesTotal.slice();
        filtered.samplesTotal[0] = 42;
        assert.deepEqual(population.samplesTotal, originalTotals);
    });
});
