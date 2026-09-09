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
