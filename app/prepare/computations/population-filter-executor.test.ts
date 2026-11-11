import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PopulationFilter, type EventAcceptance, type EventClasses } from './population-filter.js';
import type { PreparedAttributeFilter } from './attribute-filter.js';
import { Population, PopulationFiltered } from './population.js';

// An executor over a mask it keeps, as a population keeps its samples mask; every application records its event
// acceptance
function createExecutor(sampleCount: number, eventCount: number) {
    const mask = new Uint32Array(sampleCount);
    const applications: (EventAcceptance | null)[] = [];
    const apply = (updateMask: (mask: Uint32Array) => void, acceptedEvents: EventAcceptance | null) => {
        updateMask(mask);
        applications.push(acceptedEvents);
    };

    return {
        executor: new PopulationFilter(sampleCount, eventCount, apply),
        mask,
        applications
    };
}

// Acceptance of every event, one table lookup per event
function eventFlags(acceptance: EventAcceptance | null) {
    const flags: number[] = [];

    for (let i = 0; i < acceptance!.values.length; i++) {
        flags.push(acceptance!.accepts[acceptance!.values[i]]);
    }

    return flags;
}

// Filters of a single sample that reject it
function createRejectingFilters(count: number) {
    const filters: PreparedAttributeFilter[] = [];

    for (let i = 0; i < count; i++) {
        filters.push({
            key: `filter ${i}`,
            domain: 'sample',
            size: 1,
            accepts: Uint8Array.of(0)
        });
    }

    return filters;
}

test('gives every sample filter its own bit of the mask, at most 32 of them', () => {
    const { executor, mask } = createExecutor(1, 0);
    const filters = createRejectingFilters(33);

    executor.batch(() => {
        for (let i = 0; i < 32; i++) {
            executor.set(filters[i]);
        }
    });

    assert.equal(mask[0], 0xffffffff);
    assert.throws(() => executor.set(filters[32]), /at most 32/);
});

test('clears the bit of a removed filter and gives it to the next filter', () => {
    const { executor, mask } = createExecutor(1, 0);
    const filters = createRejectingFilters(32);
    const next: PreparedAttributeFilter = { key: 'next', domain: 'sample', size: 1, accepts: null };

    executor.batch(() => {
        for (let i = 0; i < 32; i++) {
            executor.set(filters[i]);
        }
    });
    executor.batch(() => {
        executor.remove('filter 31');
        executor.set(next);
    });

    assert.equal(mask[0], 0x7fffffff);

    // The only free bit is the one of the removed filter
    executor.set({ ...next, accepts: Uint8Array.of(0) });

    assert.equal(mask[0], 0xffffffff);
});

test('sets the bit of a sample filter for samples it rejects, by sample ID or by the values of samples', () => {
    const { executor, mask } = createExecutor(3, 0);
    const bySample: PreparedAttributeFilter = {
        key: 'by sample',
        domain: 'sample',
        size: 3,
        accepts: Uint8Array.of(0, 1, 1)
    };
    const byValue: PreparedAttributeFilter = {
        key: 'by value',
        domain: 'sample',
        size: 3,
        values: Uint8Array.of(1, 0, 1),
        accepts: Uint8Array.of(1, 0)
    };

    executor.set(bySample);
    executor.set(byValue);

    assert.deepEqual([...mask], [3, 0, 2]);

    executor.set({ ...bySample, accepts: null });

    assert.deepEqual([...mask], [2, 0, 2]);
});

test('applies a batch of changes once, and nested batches with the outermost one', () => {
    const { executor, mask, applications } = createExecutor(2, 0);

    executor.batch(() => {
        executor.set({
            key: 'first',
            domain: 'sample',
            size: 2,
            accepts: Uint8Array.of(0, 1)
        });
        executor.set({
            key: 'second',
            domain: 'sample',
            size: 2,
            accepts: Uint8Array.of(1, 0)
        });
    });

    assert.equal(applications.length, 1);
    assert.deepEqual([...mask], [1, 2]);

    executor.batch(() => {
        executor.batch(() => {
            executor.remove('first');
        });

        assert.equal(applications.length, 1);

        executor.remove('second');
    });

    assert.equal(applications.length, 2);
    assert.deepEqual([...mask], [0, 0]);
});

test('applies nothing for inactive filters and for the same prepared filter again', () => {
    const { executor, applications } = createExecutor(2, 2);
    const samples: PreparedAttributeFilter = {
        key: 'samples',
        domain: 'sample',
        size: 2,
        accepts: Uint8Array.of(0, 1)
    };

    executor.set({ key: 'events', domain: 'event', size: 2, accepts: null });
    executor.set({ ...samples, accepts: null });

    assert.equal(applications.length, 0);

    executor.set(samples);
    executor.set(samples);
    executor.remove('events');

    assert.equal(applications.length, 1);
});

test('rejects a filter of another domain size and a domain change of a registered key', () => {
    const { executor } = createExecutor(3, 4);
    const sampleOfEventSize: PreparedAttributeFilter = { key: 'other', domain: 'sample', size: 4, accepts: null };
    const eventOfSampleSize: PreparedAttributeFilter = { key: 'other', domain: 'event', size: 3, accepts: null };
    const changedDomain: PreparedAttributeFilter = { key: 'attribute', domain: 'event', size: 4, accepts: null };

    executor.set({ key: 'attribute', domain: 'sample', size: 3, accepts: null });

    assert.throws(() => executor.set(sampleOfEventSize), /incompatible/);
    assert.throws(() => executor.set(eventOfSampleSize), /incompatible/);
    assert.throws(() => executor.set(changedDomain), /cannot change/);
});

test('passes the acceptance of a single event filter as is, apart from the sample mask', () => {
    const { executor, mask, applications } = createExecutor(2, 4);
    const byEvent: PreparedAttributeFilter = {
        key: 'by event',
        domain: 'event',
        size: 4,
        accepts: Uint8Array.of(0, 1, 1, 0)
    };
    const byValue: PreparedAttributeFilter = {
        key: 'by value',
        domain: 'event',
        size: 4,
        values: Uint8Array.of(2, 0, 1, 2),
        accepts: Uint8Array.of(1, 0, 0)
    };

    executor.batch(() => {
        executor.set({
            key: 'samples',
            domain: 'sample',
            size: 2,
            accepts: Uint8Array.of(1, 0)
        });
        executor.set(byEvent);
    });

    assert.deepEqual([...mask], [0, 1]);
    assert.equal(applications[0]!.values, byEvent.accepts);
    assert.deepEqual(eventFlags(applications[0]), [0, 1, 1, 0]);

    executor.batch(() => {
        executor.remove('by event');
        executor.set(byValue);
    });

    assert.equal(applications[1]!.values, byValue.values);
    assert.deepEqual(eventFlags(applications[1]), [0, 1, 0, 0]);

    executor.remove('by value');

    assert.equal(applications[2], null);
    assert.deepEqual([...mask], [0, 1]);
});

test('intersects several event filters per event', () => {
    const { executor, applications } = createExecutor(1, 4);

    executor.batch(() => {
        executor.set({
            key: 'lifespan',
            domain: 'event',
            size: 4,
            values: Uint8Array.of(0, 1, 2, 0),
            accepts: Uint8Array.of(1, 0, 1)
        });
        executor.set({
            key: 'space',
            domain: 'event',
            size: 4,
            values: Uint32Array.of(3, 3, 1, 1),
            accepts: Uint8Array.of(0, 0, 0, 1)
        });
    });

    assert.deepEqual(eventFlags(applications[0]), [1, 0, 0, 0]);
});

test('intersects event filters per class when the classes keep their values together', () => {
    const { executor, applications } = createExecutor(1, 6);
    // Events 0 and 5 have equal values of both vectors, so they make one class
    const lifespan = Uint8Array.of(0, 1, 1, 0, 2, 0);
    const space = Uint32Array.of(3, 3, 1, 1, 3, 3);
    const classes: EventClasses = {
        ids: Uint8Array.of(0, 1, 2, 3, 4, 0),
        events: Uint32Array.of(0, 1, 2, 3, 4),
        values: new Set([lifespan, space])
    };

    executor.setEventClasses(classes);
    executor.batch(() => {
        executor.set({
            key: 'lifespan',
            domain: 'event',
            size: 6,
            values: lifespan,
            accepts: Uint8Array.of(1, 0, 1)
        });
        executor.set({
            key: 'space',
            domain: 'event',
            size: 6,
            values: space,
            accepts: Uint8Array.of(0, 0, 0, 1)
        });
    });

    assert.equal(applications[0]!.values, classes.ids);
    assert.deepEqual([...applications[0]!.accepts], [1, 0, 0, 0, 1]);

    // Values the classes don't keep together are intersected per event
    executor.set({
        key: 'other',
        domain: 'event',
        size: 6,
        values: Uint8Array.of(0, 0, 0, 0, 1, 0),
        accepts: Uint8Array.of(1, 0)
    });

    assert.notEqual(applications[1]!.values, classes.ids);
    assert.deepEqual(eventFlags(applications[1]), [1, 0, 0, 0, 0, 1]);
});

// Values of two event attributes of 4 events; every event makes its own class of them
const lifespanValues = Uint8Array.of(0, 1, 2, 0);
const spaceValues = Uint32Array.of(3, 3, 1, 1);

test.each([
    {
        name: 'per event',
        classes: null
    },
    {
        name: 'per class',
        classes: {
            ids: Uint8Array.of(0, 1, 2, 3),
            events: Uint32Array.of(0, 1, 2, 3),
            values: new Set([lifespanValues, spaceValues])
        }
    }
])('a population routes events rejected by any event filter to the sink: $name', row => {
    const base = new Population(Uint32Array.of(0, 1, 0, 1), Uint32Array.of(10, 20, 30, 40));
    const population = new PopulationFiltered(base);
    const lifespanFilter: PreparedAttributeFilter = {
        key: 'lifespan',
        domain: 'event',
        size: 4,
        values: lifespanValues,
        accepts: Uint8Array.of(1, 0, 1)
    };
    const spaceFilter: PreparedAttributeFilter = {
        key: 'space',
        domain: 'event',
        size: 4,
        values: spaceValues,
        accepts: Uint8Array.of(0, 1, 0, 1)
    };

    population.filter.setEventClasses(row.classes);
    population.filter.set(lifespanFilter);
    population.filter.set(spaceFilter);

    assert.deepEqual([...population.samples], [0, 2, 0, 1]);

    population.filter.set({ ...spaceFilter, accepts: Uint8Array.of(0, 0, 0, 1) });

    assert.deepEqual([...population.samples], [0, 2, 2, 2]);
    assert.deepEqual([...population.samplesTotal], [10, 0]);

    population.filter.remove('lifespan');

    assert.deepEqual([...population.samples], [0, 1, 2, 2]);
    assert.deepEqual([...population.samplesTotal], [10, 20]);
});
