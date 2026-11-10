import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Population, PopulationFiltered } from '../prepare/computations/population.js';
import { methods } from './samples.js';
import { createLineFixture } from '../../test/fixtures/profile.js';

test('a population event count includes zero-weight events at positions within ranges and accepted by filters', () => {
    // Events at positions 0, 10, 10, 20, 20, 25 (ends at 25)
    const population = new Population(new Uint32Array([0, 1, 0, 1, 0, 1]), new Uint32Array([10, 0, 10, 0, 5, 0]));
    const viewport = new PopulationFiltered(population);
    const count = () => methods.populationEventCount(viewport);

    assert.deepEqual(Array.from(population.zeroEvents), [1, 3, 5]);
    assert.equal(count(), 6);

    viewport.setRanges([{ start: 5, end: 20 }]);
    assert.equal(count(), 3);
    viewport.setRanges([{ start: 0, end: 5 }, { start: 20, end: 26 }]);
    assert.equal(count(), 4);
    viewport.setRanges([]);
    assert.equal(count(), 0);
    viewport.setRanges(null);

    viewport.filter.set({ key: 'test', domain: 'sample', size: 2, accepts: new Uint8Array([1, 0]) });
    assert.equal(count(), 3);
    viewport.destroy();
});

test.each([
    { name: 'a viewport around the line', scopeViewport: { start: 100, end: 200 }, count: 10, intersecting: [0, 0, 1, 2, 2, 0, 0, 0, 0, 0], starts: [0, 0, 1, 1, 1, 0, 0, 0, 0, 0] },
    { name: 'a narrow viewport', scopeViewport: { start: 130, end: 140 }, count: 2, intersecting: [1, 1], starts: [0, 1] }
])('sample counters of $name count intersecting events per bin and visible event starts once', async ({ scopeViewport, count, intersecting, starts }) => {
    // Events at 125–135, 135–145 and 145–150
    const { profile, line, breakdown } = await createLineFixture({ origin: 125 });
    const context = { scopeViewport, scopeLine: line, scopeProfile: profile, scopeBreakdown: breakdown };

    assert.deepEqual(Array.from(methods.countSamples.call({ context }, count)), intersecting);
    assert.deepEqual(Array.from(methods.countSamplesDiscrete.call({ context }, count, undefined)), starts);
});

// Index and value constraints leave the events they reject in place with no weight: counters skip them
test.each([
    { name: 'an index range of the last two events', constrain: (viewport: PopulationFiltered) => viewport.setIndexRange(1, 3), intersecting: [0, 0, 0, 1, 2], starts: [0, 0, 0, 1, 1] },
    { name: 'an index range of the first two events', constrain: (viewport: PopulationFiltered) => viewport.setIndexRange(0, 2), intersecting: [0, 0, 1, 2, 1], starts: [0, 0, 1, 1, 0] },
    { name: 'a minimal value', constrain: (viewport: PopulationFiltered) => viewport.setValueRange(10, null), intersecting: [0, 0, 1, 2, 1], starts: [0, 0, 1, 1, 0] },
    // The second event ends the first range and starts the second one in the same bin; the third event alone is accepted
    { name: 'a value range over ranges cutting an event', constrain: (viewport: PopulationFiltered) => {
        viewport.setRanges([{ start: 0, end: 13 }, { start: 14, end: 25 }]);
        viewport.setValueRange(null, 6);
    }, intersecting: [0, 0, 0, 0, 1], starts: [0, 0, 0, 0, 1] }
])('sample counters skip events rejected by $name', async ({ constrain, intersecting, starts }) => {
    // Events at 125–135, 135–145 and 145–150 of values 10, 10 and 5; bins of 10 from 100
    const { profile, line, breakdown } = await createLineFixture({ origin: 125 });
    const context = { scopeViewport: { start: 100, end: 150 }, scopeLine: line, scopeProfile: profile, scopeBreakdown: breakdown };

    constrain(breakdown.populationWindow);
    assert.deepEqual(Array.from(methods.countSamples.call({ context }, 5)), intersecting);
    assert.deepEqual(Array.from(methods.countSamplesDiscrete.call({ context }, 5, undefined)), starts);
});
