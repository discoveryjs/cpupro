import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PopulationFilter, type EventAcceptance } from './population-filter.js';
import type { PreparedAttributeFilter } from './attribute-filter.js';
import { Population, PopulationFiltered } from './population.js';

test('uses all 32 bits and clears a removed bit before reuse', () => {
    const mask = new Uint32Array(1);
    const executor = new PopulationFilter(1, 0, update => update(mask));
    const filters: PreparedAttributeFilter[] = Array.from({ length: 33 }, (_, index) => ({
        key: String(index), domain: 'sample', size: 1, accepts: null
    }));
    executor.batch(() => filters.slice(0, 32).forEach(filter => executor.set(filter)));
    assert.throws(() => executor.set(filters[32]), /at most 32/);
    executor.set({ ...filters[31], accepts: new Uint8Array(1) });
    assert.equal(mask[0], 0x80000000);
    executor.batch(() => {
        executor.remove('31');
        executor.set(filters[32]);
    });
    assert.equal(mask[0], 0);
    executor.set({ ...filters[32], accepts: new Uint8Array(1) });
    assert.equal(mask[0], 0x80000000);
    executor.set(filters[32]);
    assert.equal(mask[0], 0);
});

test('batches prepared predicates, ignores identical inputs and keeps event and sample domains separate', () => {
    const mask = new Uint32Array(3);
    let applications = 0;
    let acceptsEvent: EventAcceptance | null = null;
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
    const active = { ...first, accepts: Uint8Array.of(1, 0, 1) };
    executor.batch(() => {
        executor.set(active);
        executor.set({ ...second, accepts: Uint8Array.of(0, 0, 1, 1) });
    });
    assert.equal(applications, 1);
    assert.deepEqual([...mask], [0, 1, 0]);
    assert.deepEqual(Array.from(acceptsEvent!.values, value => acceptsEvent!.accepts[value]), [0, 0, 1, 1]);
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
        key: 'attribute', domain, size: domain === 'sample' ? 2 : 3, accepts: Uint8Array.of(1, 0, 1).subarray(0, domain === 'sample' ? 2 : 3)
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
    population.filter.set({ ...prepared, accepts: new Uint8Array(prepared.size) });
    assert.equal(population.sink.total, 30);
    population.filter.remove('attribute');
    assert.equal(population.rangeStart, 5);
    assert.equal(population.sink.total, 0);
    assert.deepEqual([...population.samplesTotal], [10, 20]);
    population.resetRange();
    assert.deepEqual(population.samplesTotal, population.population.samplesTotal);
});

test('intersects event filters over attribute values without changing sample destinations of accepted events', () => {
    const population = new PopulationFiltered(new Population(new Uint32Array([0, 1, 0, 1]), new Uint32Array([10, 20, 30, 40])));
    const lifespan = { key: 'lifespan', domain: 'event' as const, size: 4, values: Uint8Array.of(0, 1, 2, 0), accepts: Uint8Array.of(1, 0, 1) };
    const space = { key: 'space', domain: 'event' as const, size: 4, values: Uint32Array.of(3, 3, 1, 1), accepts: Uint8Array.of(0, 1, 0, 1) };
    const sinkId = population.sinkId;

    population.filter.set(lifespan);
    assert.deepEqual([...population.samples], [0, sinkId, 0, 1]);
    population.filter.set(space);
    assert.deepEqual([...population.samples], [0, sinkId, 0, 1]);
    population.filter.set({ ...space, accepts: Uint8Array.of(0, 0, 0, 1) });
    assert.deepEqual([...population.samples], [0, sinkId, sinkId, sinkId]);
    assert.deepEqual([...population.samplesTotal], [10, 0]);
    population.filter.remove('lifespan');
    assert.deepEqual([...population.samples], [0, 1, sinkId, sinkId]);
    assert.deepEqual([...population.samplesTotal], [10, 20]);
});

test('intersects event filters per class when classes keep their values together', () => {
    const population = new PopulationFiltered(new Population(new Uint32Array([0, 1, 0, 1, 0]), new Uint32Array([10, 20, 30, 40, 50])));
    const lifespan = Uint8Array.of(0, 1, 1, 0, 2);
    const space = Uint32Array.of(3, 3, 1, 1, 3);
    const other = Uint8Array.of(0, 0, 0, 0, 1);
    const sinkId = population.sinkId;
    let acceptedEvents: EventAcceptance | null = null;
    const executor = new PopulationFilter(2, 5, (update, accepted) => {
        acceptedEvents = accepted;
        update(new Uint32Array(2));
    });
    const classes = {
        ids: Uint16Array.of(0, 1, 2, 3, 4),
        events: Uint32Array.of(0, 1, 2, 3, 4),
        values: new Set([lifespan, space])
    };

    population.filter.setEventClasses(classes);
    population.filter.set({ key: 'lifespan', domain: 'event', size: 5, values: lifespan, accepts: Uint8Array.of(1, 0, 1) });
    population.filter.set({ key: 'space', domain: 'event', size: 5, values: space, accepts: Uint8Array.of(0, 0, 0, 1) });
    assert.deepEqual([...population.samples], [0, sinkId, sinkId, sinkId, 0]);
    assert.deepEqual([...population.samplesTotal], [60, 0]);

    executor.setEventClasses(classes);
    executor.batch(() => {
        executor.set({ key: 'lifespan', domain: 'event', size: 5, values: lifespan, accepts: Uint8Array.of(1, 0, 1) });
        executor.set({ key: 'space', domain: 'event', size: 5, values: space, accepts: Uint8Array.of(0, 0, 0, 1) });
    });
    assert.equal(acceptedEvents!.values, classes.ids);
    assert.deepEqual([...acceptedEvents!.accepts], [1, 0, 0, 0, 1]);

    // A filter over values the classes don't keep together intersects per event
    executor.set({ key: 'other', domain: 'event', size: 5, values: other, accepts: Uint8Array.of(1, 0) });
    assert.notEqual(acceptedEvents!.values, classes.ids);
    assert.deepEqual(Array.from(acceptedEvents!.values, value => acceptedEvents!.accepts[value]), [1, 0, 0, 0, 0]);
});
