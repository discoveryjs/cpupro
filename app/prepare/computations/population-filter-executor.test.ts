import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PopulationFilter } from './population-filter.js';
import type { Acceptance, PreparedAttributeFilter } from './attribute-filter.js';
import { Population, PopulationFiltered } from './population.js';

test('uses all 32 bits and clears a removed bit before reuse', () => {
    const mask = new Uint32Array(1);
    const executor = new PopulationFilter(1, 0, update => update(mask));
    const filters: PreparedAttributeFilter[] = Array.from({ length: 33 }, (_, index) => ({
        key: String(index), domain: 'sample', size: 1, accepts: null
    }));
    executor.batch(() => filters.slice(0, 32).forEach(filter => executor.set(filter)));
    assert.throws(() => executor.set(filters[32]), /at most 32/);
    executor.set({ ...filters[31], accepts: () => false });
    assert.equal(mask[0], 0x80000000);
    executor.batch(() => {
        executor.remove('31');
        executor.set(filters[32]);
    });
    assert.equal(mask[0], 0);
    executor.set({ ...filters[32], accepts: () => false });
    assert.equal(mask[0], 0x80000000);
    executor.set(filters[32]);
    assert.equal(mask[0], 0);
});

test('batches prepared predicates, ignores identical inputs and keeps event and sample domains separate', () => {
    const mask = new Uint32Array(3);
    let applications = 0;
    let acceptsEvent: Acceptance | null = null;
    const executor = new PopulationFilter(3, 4, (update, accepts) => {
        applications++;
        acceptsEvent = accepts;
        update(mask);
    });
    const first: PreparedAttributeFilter = { key: 'first', domain: 'sample', size: 3, accepts: null };
    const second: PreparedAttributeFilter = { key: 'second', domain: 'event', size: 4, accepts: null };
    executor.batch(() => {
        executor.set(first); executor.set(second);
    });
    assert.equal(applications, 0);
    const active = { ...first, accepts: (index: number) => index % 2 === 0 };
    executor.batch(() => {
        executor.set(active);
        executor.set({ ...second, accepts: index => index > 1 });
    });
    assert.equal(applications, 1);
    assert.deepEqual([...mask], [0, 1, 0]);
    assert.deepEqual([0, 1, 2, 3].map(index => acceptsEvent!(index)), [false, false, true, true]);
    executor.set(active);
    assert.equal(applications, 1);
    assert.throws(() => executor.set({ ...second, size: 3 }), /incompatible/);
    assert.throws(() => executor.set({ ...first, domain: 'event', size: 4 }), /cannot change/);
    executor.batch(() => {
        executor.remove('first'); executor.remove('second');
    });
    assert.equal(applications, 2);
    assert.deepEqual([...mask], [0, 0, 0]);
    assert.equal(acceptsEvent, null);
});

test.each(['sample', 'event'] as const)('preserves prepared %s acceptance when resetting raw mask and range', domain => {
    const population = new PopulationFiltered(new Population(new Uint32Array([0, 1, 0]), new Uint32Array([10, 20, 30])));
    const prepared: PreparedAttributeFilter = {
        key: 'attribute', domain, size: domain === 'sample' ? 2 : 3, accepts: index => index % 2 === 0
    };
    population.setRange(5, 35);
    population.filter.set(prepared);
    assert.deepEqual([...population.samplesTotal], [10, 0]);
    assert.equal(population.sink.total, 20);
    population.updateMask(mask => {
        mask[0] |= 0x80000000;
    });
    assert.equal(population.sink.total, 30);
    population.resetMask();
    assert.equal(population.filter.get('attribute'), prepared);
    assert.equal(population.sink.total, 20);
    population.filter.set({ ...prepared, accepts: () => false });
    assert.equal(population.sink.total, 30);
    population.filter.remove('attribute');
    assert.equal(population.rangeStart, 5);
    assert.equal(population.sink.total, 0);
    assert.deepEqual([...population.samplesTotal], [10, 20]);
    population.resetRange();
    assert.deepEqual(population.samplesTotal, population.population.samplesTotal);
});
