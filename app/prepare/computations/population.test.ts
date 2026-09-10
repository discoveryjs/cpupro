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
        assert.deepEqual([...population.samplesCount], [0, 0, 1, 0, 0, 0, 0, 2]);
        assert.deepEqual([...population.samplesTotal], [0, 0, 8, 0, 0, 0, 0, 48]);
    });
});

describe('PopulationFiltered', () => {
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
        assert.deepEqual([...filtered.values], values);
        assert.equal(filtered.rangeSamples, count);
        assert.equal(filtered.samplesCount.reduce((sum, value) => sum + value, 0), count);
        assert.deepEqual([...population.values], [0, 10, 0, 20, 0, 30, 0]);
    });

    test('combines all constraints from original values, without re-evaluating the bucket filter', () => {
        const population = new Population(new Uint32Array([0, 1, 0, 2, 1]), new Uint32Array([10, 20, 30, 40, 0]));
        const first = new PopulationFiltered(population);
        const second = new PopulationFiltered(population);
        let filterCalls = 0;
        const maskFn = (mask: Uint32Array) => {
            filterCalls++; mask[0] |= 1;
        };
        first.updateMask(maskFn);
        first.setRange(15, 65);
        first.setIndexRange(1, 4);
        first.setValueRange(20, 40);
        second.setValueRange(20, 40);
        second.setIndexRange(1, 4);
        second.setRange(15, 65);
        second.updateMask(maskFn);
        assert.equal(filterCalls, 2);
        assert.deepEqual([...first.values], [0, 15, 30, 0, 0]);
        assert.deepEqual([...first.samplesTotal], [0, 15, 0]);
        assert.deepEqual(first.sink, { count: 1, total: 30 });
        assert.deepEqual(first.values, second.values);
        assert.deepEqual(first.samples, second.samples);
        assert.deepEqual(first.samplesTotal, second.samplesTotal);
        assert.deepEqual(first.sink, second.sink);

        first.resetRange();
        assert.deepEqual([...first.values], [0, 20, 30, 0, 0]);
        first.resetValueRange();
        assert.deepEqual([...first.values], [0, 20, 30, 40, 0]);
        first.resetIndexRange();
        assert.deepEqual(first.values, population.values);
        assert.deepEqual(first.sink, { count: 2, total: 40 });
        first.resetMask();
        assert.deepEqual(first.samples, population.samples);
        assert.deepEqual(first.samplesTotal, population.samplesTotal);
        assert.equal(filterCalls, 2);

        second.resetMask();
        assert.deepEqual([...second.samplesTotal], [30, 15, 0]);
        assert.deepEqual(second.sink, { count: 0, total: 0 });
        assert.deepEqual([...population.values], [10, 20, 30, 40, 0]);
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
        assert.throws(() => filtered.setRange(20, 10), RangeError);
        assert.throws(() => filtered.setIndexRange(0.5, 1), RangeError);
        assert.throws(() => filtered.setValueRange(NaN, 1), RangeError);
        assert.deepEqual([...filtered.values], [10, 20, 0]);
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
            assert.deepEqual([...filtered.values], [0, 15, 30, 0]);
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
        assert.equal(filtered.buffer.samplesTotal.length, 4);
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
        assert.equal(filtered.samples, filtered.buffer.samples);
        assert.equal(filtered.values, values);
        assert.equal(filtered.samplesCount, counts);
        assert.equal(filtered.samplesTotal, totals);
        assert.deepEqual(totals, population.samplesTotal);
    });

    test('combines range and mask independently of update order', () => {
        const population = new Population(new Uint32Array([0, 1, 0]), new Uint32Array([10, 20, 30]));
        const first = new PopulationFiltered(population);
        const second = new PopulationFiltered(population);
        first.updateMask(mask => {
            mask[0] = 1;
        });
        first.setRange(5, 35);
        second.setRange(5, 35);
        second.updateMask(mask => {
            mask[0] = 1;
        });
        assert.deepEqual(first.samples, second.samples);
        assert.deepEqual(first.values, second.values);
        assert.deepEqual([...first.samplesTotal], [0, 20]);
        assert.deepEqual(first.samplesTotal, second.samplesTotal);
        assert.deepEqual(first.sink, { count: 2, total: 10 });
        first.resetMask();
        assert.deepEqual([...first.samplesTotal], [10, 20]);
        assert.deepEqual(first.sink, { count: 0, total: 0 });
        second.resetRange();
        assert.deepEqual([...second.samplesTotal], [0, 20]);
        assert.deepEqual(second.sink, { count: 2, total: 40 });
        second.resetMask();
        assert.deepEqual(second.samplesTotal, population.samplesTotal);
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
            assert.equal(filtered[key].buffer, filtered.buffer.memory!.buffer);
        }
        const originalTotals = population.samplesTotal.slice();
        filtered.samplesTotal[0] = 42;
        assert.deepEqual(population.samplesTotal, originalTotals);
    });

    test('updates a range once and resets without mutating the base population', () => {
        const population = new Population(new Uint32Array([0, 1, 0]), new Uint32Array([10, 20, 30]));
        const filtered = new PopulationFiltered(population);
        let notifications = 0;
        const unsubscribe = filtered.subscribe(() => notifications++);

        filtered.setRange(5, 35);
        assert.deepEqual([...filtered.values], [5, 20, 5]);
        assert.deepEqual([...filtered.samplesTotal], [10, 20]);
        assert.deepEqual([...filtered.samplesCount], [2, 1]);
        assert.equal(notifications, 1);
        assert.deepEqual([...population.values], [10, 20, 30]);
        assert.deepEqual([...population.samplesTotal], [40, 20]);

        filtered.resetRange();
        assert.deepEqual(filtered.values, population.values);
        assert.deepEqual(filtered.samplesTotal, population.samplesTotal);
        assert.deepEqual(filtered.samplesCount, population.samplesCount);
        assert.equal(filtered.rangeStart, null);
        assert.equal(filtered.rangeEnd, null);
        assert.equal(notifications, 2);
        filtered.resetRange();
        assert.equal(notifications, 2);
        unsubscribe();
    });
});
