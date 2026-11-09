import assert from 'node:assert/strict';
import { describe, inject, test } from 'vitest';
import { Population, PopulationFiltered } from './population.js';

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
    ])('keeps the base cumulative endpoint under filtered constraints: $values', ({ values, end }) => {
        const population = new Population(new Uint32Array(values.length), Uint32Array.from(values));
        const filtered = new PopulationFiltered(population);
        assert.equal(population.cumulativeEnd, end);
        filtered.setRange(5, end + 10);
        filtered.setValueRange(20, null);
        filtered.updateMask(mask => mask.fill(1));
        assert.equal(population.cumulativeEnd, end);
        assert.deepEqual([...population.values], values);
        filtered.resetRange();
        filtered.resetValueRange();
        filtered.resetMask();
        assert.equal(population.cumulativeEnd, end);
    });
});

describe('PopulationFiltered', () => {
    test('attribute aggregation skips gaps and counts shared boundary events once', () => {
        const population = new Population(new Uint32Array(100_000), new Uint32Array(100_000).fill(10));
        const filtered = new PopulationFiltered(population);
        filtered.setRanges([{ start: 101, end: 102 }, { start: 105, end: 106 }, { start: 900_001, end: 900_003 }]);
        let reads = 0;
        Object.defineProperty(filtered, 'values', { value: new Proxy(filtered.values, {
            get(target, property) {
                if (typeof property === 'string' && /^\d+$/.test(property)) {
                    const index = Number(property);
                    assert.ok(index === 10 || index === 90_000, `Unexpected gap event ${index}`);
                    reads++;
                }
                return Reflect.get(target, property, target);
            }
        }) });

        const result = filtered.aggregateBy(new Uint8Array(population.values.length), 1);

        assert.deepEqual([...result.samplesTotal], [4]);
        assert.deepEqual([...result.samplesCount], [2]);
        assert.equal(reads, 2 + filtered.boundaryCuts.length);
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
            samplesCount: new Uint32Array([0, 2, 1]), samplesTotal: new Float64Array([0, 48, 48])
        });

        const verify = (counts: number[], totals: number[]) => {
            const metrics = filtered.aggregateBy(groups, 3);
            assert.deepEqual([...metrics.samplesCount], counts);
            assert.deepEqual([...metrics.samplesTotal], totals);
            assert.equal(filtered.samples, destinations);
            assert.equal(filtered.values, values);
            assert.deepEqual(filtered.aggregateBy(filtered.samples, filtered.samplesCount.length), {
                samplesCount: filtered.samplesCount, samplesTotal: filtered.samplesTotal
            });
        };

        filtered.setRanges([{ start: 1, end: 1.4 }, { start: 8, end: 8.4 }]);
        verify([0, 0, 0], [0, 0, 0]);
        filtered.setRanges([{ start: 1, end: 1.6 }, { start: 8, end: 8.6 }, { start: 20, end: 24 }]);
        verify([0, 2, 0], [0, 5, 0]);
        filtered.updateMask(mask => {
            mask[1] = 1;
        });
        verify([0, 1, 0], [0, 1, 0]);
        filtered.resetMask();
        filtered.resetRange();
        viewport.setRange(5, 40);
        filtered.setRange(10, 24);
        verify([0, 2, 0], [0, 14, 0]);
        filtered.setIndexRange(1, 2);
        verify([0, 1, 0], [0, 8, 0]);
        filtered.resetIndexRange();
        filtered.setValueRange(20, null);
        verify([0, 1, 0], [0, 8, 0]);
        filtered.filter.set({ key: 'row', domain: 'event', size: 3, accepts: Uint8Array.of(1, 0, 1) });
        verify([0, 0, 0], [0, 0, 0]);
        filtered.destroy();
        viewport.destroy();
    });

    test('moves and resets ranges without evaluating event acceptance or rebuilding sample destinations', () => {
        const population = new Population(new Uint32Array([0, 1, 0, 2, 1]), new Uint32Array([10, 0, 20, 30, 0]));
        const filtered = new PopulationFiltered(population);
        const predicate = { key: 'event', domain: 'event' as const, size: population.values.length, accepts: Uint8Array.of(1, 0, 1, 0, 1) };
        filtered.filter.set(predicate);
        const destinations = filtered.samples.slice();
        let filterUpdates = 0;
        filtered.filter.subscribe(() => filterUpdates++);

        for (const [start, end] of [[5, 35], [35, 55], [10, 10], [0, 60], [0.5, 30.5]]) {
            filtered.setRange(start, end);
            const expected = population.values.map((value, index) =>
                Math.max(0, Math.min(population.cumulative[index] + value, end) - Math.max(population.cumulative[index], start)) > 0 ? value : 0
            );
            assert.deepEqual(filtered.values, expected);
            assert.deepEqual(filtered.samples, destinations);
        }

        filtered.resetRange();
        assert.deepEqual(filtered.values, population.values);
        assert.deepEqual(filtered.samples, destinations);
        assert.equal(filtered.filter.get('event'), predicate);
        assert.equal(filterUpdates, 0);
    });

    test.each([
        { start: 0, end: 10, values: [0, 10, 0, 0, 0, 0, 0], count: 1 },
        { start: 10, end: 30, values: [0, 0, 0, 20, 0, 0, 0], count: 1 },
        { start: 5, end: 35, values: [0, 5, 0, 20, 0, 5, 0], count: 3 },
        { start: 10, end: 10, values: [0, 0, 0, 0, 0, 0, 0], count: 0 },
        { start: -10, end: 100, values: [0, 10, 0, 20, 0, 30, 0], count: 3 },
        { start: 60, end: 80, values: [0, 0, 0, 0, 0, 0, 0], count: 0 }
    ])('clips half-open ranges with zero-sized events: [$start, $end)', ({ start, end, values, count }) => {
        const population = new Population(new Uint32Array([0, 0, 0, 1, 1, 2, 2]), new Uint32Array([0, 10, 0, 20, 0, 30, 0]));
        const filtered = new PopulationFiltered(population);
        filtered.setRange(start, end);
        assert.deepEqual([...filtered.values], values.map((value, index) => value > 0 ? population.values[index] : 0));
        assert.deepEqual([...filtered.samplesTotal], [values[1], values[3], values[5]]);
        assert.equal(filtered.rangeSamples, count);
        assert.equal(filtered.samplesCount.reduce((sum, value) => sum + value, 0), count);
        assert.deepEqual([...population.values], [0, 10, 0, 20, 0, 30, 0]);
    });

    test('resets each constraint independently, without re-running the mask update', () => {
        const population = new Population(new Uint32Array([0, 1, 0, 2, 1]), new Uint32Array([10, 20, 30, 40, 0]));
        const filtered = new PopulationFiltered(population);
        let maskUpdates = 0;

        filtered.updateMask(mask => {
            maskUpdates++;
            mask[0] |= 1;
        });
        filtered.setRange(15, 65);
        filtered.setIndexRange(1, 4);
        filtered.setValueRange(20, 40);
        assert.deepEqual([...filtered.values], [0, 20, 30, 0, 0]);
        assert.deepEqual([...filtered.samplesTotal], [0, 15, 0]);
        assert.deepEqual(filtered.sink, { count: 1, total: 30 });

        filtered.resetRange();
        assert.deepEqual([...filtered.values], [0, 20, 30, 0, 0]);
        filtered.resetValueRange();
        assert.deepEqual([...filtered.values], [0, 20, 30, 40, 0]);
        filtered.resetIndexRange();
        assert.deepEqual(filtered.values, population.values);
        assert.deepEqual(filtered.sink, { count: 2, total: 40 });
        filtered.resetMask();
        assert.deepEqual(filtered.samples, population.samples);
        assert.deepEqual(filtered.samplesTotal, population.samplesTotal);
        assert.equal(maskUpdates, 1);
    });

    test('supports open index/value bounds and suppresses identical updates', () => {
        const filtered = new PopulationFiltered(new Population(new Uint32Array([0, 1, 0]), new Uint32Array([10, 20, 30])));
        let updates = 0;
        filtered.subscribe(() => updates++);
        filtered.setIndexRange(null, 2);
        filtered.setValueRange(20, null);
        assert.deepEqual([...filtered.values], [0, 20, 0]);
        filtered.setRange(0, 60);
        assert.equal(updates, 3);
        filtered.setIndexRange(null, 2);
        filtered.setValueRange(20, null);
        filtered.setRange(0, 60);
        assert.equal(updates, 3);
        filtered.setIndexRange(1, 1);
        assert.deepEqual([...filtered.values], [0, 0, 0]);
        filtered.resetIndexRange();
        filtered.setValueRange(null, 30);
        assert.deepEqual([...filtered.values], [10, 20, 0]);
        const updatesBeforeReset = updates;
        filtered.resetRange();
        filtered.resetRange();
        assert.equal(updates, updatesBeforeReset + 1);
        assert.throws(() => filtered.setRange(20, 10), RangeError);
        assert.throws(() => filtered.setIndexRange(0.5, 1), RangeError);
        assert.throws(() => filtered.setValueRange(NaN, 1), RangeError);
        assert.deepEqual([...filtered.values], [10, 20, 0]);
    });

    test.each([
        { name: 'index start', constrain: (filtered: PopulationFiltered) => filtered.setIndexRange(1, null), values: [0, 20, 30, 40], totals: [30, 60], counts: [1, 2] },
        { name: 'index end', constrain: (filtered: PopulationFiltered) => filtered.setIndexRange(null, 2), values: [10, 20, 0, 0], totals: [10, 20], counts: [1, 1] },
        { name: 'value minimum', constrain: (filtered: PopulationFiltered) => filtered.setValueRange(20, null), values: [0, 20, 30, 40], totals: [30, 60], counts: [1, 2] },
        { name: 'value maximum', constrain: (filtered: PopulationFiltered) => filtered.setValueRange(null, 30), values: [10, 20, 0, 0], totals: [10, 20], counts: [1, 1] }
    ])('applies a lone $name without coordinate ranges to aggregates and values', ({ constrain, values, totals, counts }) => {
        const population = new Population(new Uint32Array([0, 1, 0, 1]), new Uint32Array([10, 20, 30, 40]));
        const filtered = new PopulationFiltered(population);

        constrain(filtered);

        assert.deepEqual([...filtered.samplesTotal], totals);
        assert.deepEqual([...filtered.samplesCount], counts);
        assert.deepEqual(filtered.sink, { count: 0, total: 0 });
        assert.deepEqual(filtered.boundaryCuts, []);
        assert.equal(filtered.rangeSamples, null);
        assert.deepEqual([...filtered.values], values);
    });

    test.each([
        { start: null, end: 25 },
        { start: 5, end: null }
    ])('resets the coordinate range by a null endpoint: [$start, $end)', ({ start, end }) => {
        const population = new Population(new Uint32Array([0, 1]), new Uint32Array([10, 20]));
        const filtered = new PopulationFiltered(population);
        filtered.setRange(5, 25);

        filtered.setRange(start, end);

        assert.equal(filtered.ranges, null);
        assert.equal(filtered.rangeSamples, null);
        assert.deepEqual(filtered.values, population.values);
        assert.deepEqual(filtered.samplesTotal, population.samplesTotal);
    });

    test.each([
        { name: 'no constraints', constrain: () => {}, acceptsByFilters: true },
        { name: 'a coordinate range', constrain: (filtered: PopulationFiltered) => filtered.setRange(5, 65), acceptsByFilters: true },
        { name: 'a registered sample filter', constrain: (filtered: PopulationFiltered) => filtered.filter.set({ key: 'sample', domain: 'sample', size: 2, accepts: Uint8Array.of(1, 0) }), acceptsByFilters: true },
        { name: 'a registered event filter', constrain: (filtered: PopulationFiltered) => filtered.filter.set({ key: 'event', domain: 'event', size: 4, accepts: Uint8Array.of(1, 0, 1, 0) }), acceptsByFilters: true },
        { name: 'a raw mask bit', constrain: (filtered: PopulationFiltered) => filtered.updateMask(mask => {
            mask[1] |= 0x80000000;
        }), acceptsByFilters: false },
        { name: 'a reset raw mask', constrain: (filtered: PopulationFiltered) => {
            filtered.updateMask(mask => {
                mask[1] |= 0x80000000;
            });
            filtered.resetMask();
        }, acceptsByFilters: true },
        { name: 'an index start', constrain: (filtered: PopulationFiltered) => filtered.setIndexRange(1, null), acceptsByFilters: false },
        { name: 'an index end', constrain: (filtered: PopulationFiltered) => filtered.setIndexRange(null, 3), acceptsByFilters: false },
        { name: 'a value minimum', constrain: (filtered: PopulationFiltered) => filtered.setValueRange(20, null), acceptsByFilters: false },
        { name: 'a value maximum', constrain: (filtered: PopulationFiltered) => filtered.setValueRange(null, 40), acceptsByFilters: false }
    ])('event acceptance follows from registered filters alone under $name: $acceptsByFilters', ({ constrain, acceptsByFilters }) => {
        const filtered = new PopulationFiltered(new Population(new Uint32Array([0, 1, 0, 1]), new Uint32Array([10, 20, 30, 40])));

        constrain(filtered);

        assert.equal(filtered.acceptsByFilters, acceptsByFilters);
    });

    test('reads single events of compiled destinations and values without records', () => {
        const population = new Population(new Uint32Array([0, 1, 0, 1]), new Uint32Array([10, 20, 30, 40]));
        const filtered = new PopulationFiltered(population);
        const readEvents = () => {
            const reader = filtered.eventReader();
            const destinations: number[] = [];
            const values: number[] = [];

            for (let index = 0; index < population.values.length; index++) {
                destinations.push(reader.destination(index));
                values.push(reader.value(index));
            }

            return { destinations, values };
        };

        assert.deepEqual(readEvents(), { destinations: [0, 1, 0, 1], values: [10, 20, 30, 40] });

        filtered.updateMask(mask => {
            mask[1] = 1;
        });
        filtered.setRange(15, 65);

        assert.deepEqual(readEvents(), { destinations: [0, 2, 0, 2], values: [0, 20, 30, 40] });
    });

    test('produces the same result for every constraint ordering and reset ordering', () => {
        const population = new Population(new Uint32Array([0, 1, 0, 2]), new Uint32Array([10, 20, 30, 40]));
        const operations = [
            [(filtered: PopulationFiltered) => filtered.updateMask(mask => {
                mask[0] = 1;
            }), (filtered: PopulationFiltered) => filtered.resetMask()],
            [(filtered: PopulationFiltered) => filtered.setRange(15, 65), (filtered: PopulationFiltered) => filtered.resetRange()],
            [(filtered: PopulationFiltered) => filtered.setIndexRange(1, 4), (filtered: PopulationFiltered) => filtered.resetIndexRange()],
            [(filtered: PopulationFiltered) => filtered.setValueRange(20, 40), (filtered: PopulationFiltered) => filtered.resetValueRange()]
        ];
        function permutations(entries: number[]): number[][] {
            return entries.length === 0 ? [[]] : entries.flatMap(entry =>
                permutations(entries.filter(value => value !== entry)).map(rest => [entry, ...rest])
            );
        }
        for (const order of permutations([0, 1, 2, 3])) {
            const filtered = new PopulationFiltered(population);
            for (const index of order) {
                operations[index][0](filtered);
            }
            assert.deepEqual([...filtered.values], [0, 20, 30, 0]);
            assert.deepEqual([...filtered.samplesTotal], [0, 15, 0]);
            assert.deepEqual([...filtered.samplesCount], [0, 1, 0]);
            assert.deepEqual(filtered.sink, { count: 1, total: 30 });
            for (const index of order) {
                operations[index][1](filtered);
            }
            assert.deepEqual(filtered.values, population.values);
            assert.deepEqual(filtered.samples, population.samples);
            assert.deepEqual(filtered.samplesTotal, population.samplesTotal);
            assert.deepEqual(filtered.samplesCount, population.samplesCount);
            assert.deepEqual(filtered.sink, { count: 0, total: 0 });
        }
    });

    test('keeps an empty population empty under all constraints', () => {
        const filtered = new PopulationFiltered(new Population(new Uint32Array(), new Uint32Array()));
        filtered.updateMask(mask => mask.fill(1));
        filtered.setRange(0, 10);
        filtered.setIndexRange(0, 10);
        filtered.setValueRange(0, 10);
        assert.equal(filtered.values.length, 0);
        assert.equal(filtered.rangeSamples, 0);
        assert.deepEqual(filtered.sink, { count: 0, total: 0 });
        filtered.resetRange();
        filtered.resetIndexRange();
        filtered.resetValueRange();
        filtered.resetMask();
        assert.deepEqual(filtered.samplesTotal, filtered.population.samplesTotal);
    });

    test('masks buckets, including bucket zero, and keeps sink outside public aggregates', () => {
        const population = new Population(new Uint32Array([0, 2, 0, 2, 0]), new Uint32Array([10, 20, 30, 0, 40]));
        const filtered = new PopulationFiltered(population);
        const samples = filtered.samples;
        const values = filtered.values;
        const counts = filtered.samplesCount;
        const totals = filtered.samplesTotal;
        assert.equal(filtered.samplesMask.length, 3);
        assert.equal(filtered.sinkId, 3);
        assert.equal(filtered.hasMask(), false);
        assert.deepEqual(filtered.sink, { count: 0, total: 0 });

        let notifications = 0;
        filtered.subscribe(() => notifications++);
        filtered.updateMask(mask => {
            mask[0] |= 1;
        });
        assert.equal(notifications, 1);
        assert.equal(filtered.hasMask(), true);
        assert.deepEqual([...samples], [3, 2, 3, 2, 3]);
        assert.deepEqual([...totals], [0, 0, 20]);
        assert.deepEqual([...counts], [0, 0, 1]);
        assert.deepEqual(filtered.sink, { count: 3, total: 80 });
        assert.deepEqual(values, population.values);
        assert.deepEqual([...population.samples], [0, 2, 0, 2, 0]);

        filtered.updateMask(mask => {
            mask[0] |= 1 << 31;
        });
        filtered.updateMask(mask => {
            mask[0] &= ~1;
        });
        assert.equal(notifications, 1);
        assert.equal(filtered.samplesMask[0], 0x80000000);
        filtered.updateMask(mask => {
            mask[0] &= ~(1 << 31);
        });
        assert.equal(notifications, 2);
        assert.equal(filtered.hasMask(), false);
        assert.deepEqual(samples, population.samples);
        assert.deepEqual(totals, population.samplesTotal);
        assert.deepEqual(filtered.sink, { count: 0, total: 0 });

        filtered.updateMask(mask => mask.fill(1));
        assert.deepEqual([...totals], [0, 0, 0]);
        assert.deepEqual(filtered.sink, { count: 4, total: 100 });
        filtered.resetMask();
        assert.equal(notifications, 4);
        filtered.resetMask();
        assert.equal(notifications, 4);
        assert.equal(filtered.samples, samples);
        assert.equal(filtered.values, values);
        assert.equal(filtered.samplesCount, counts);
        assert.equal(filtered.samplesTotal, totals);
        assert.deepEqual(totals, population.samplesTotal);
    });

    const cases = [
        { name: 'empty', samples: [], values: [] },
        { name: 'zero weights', samples: [0, 2, 2], values: [0, 0, 0] },
        { name: 'sparse IDs', samples: [7, 0, 7, 2], values: [16, 0, 32, 8] },
        { name: 'uint32 overflow', samples: [1, 1, 4], values: [0xffffffff, 2, 0] }
    ];

    test.each(cases)('copies initial aggregates into independent buffers: $name', ({ samples, values }) => {
        const population = new Population(Uint32Array.from(samples), Uint32Array.from(values));
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
