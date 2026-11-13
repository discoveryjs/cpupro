import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Population, PopulationFiltered } from '../prepare/computations/population.js';
import { methods } from './samples.js';
import { createLineFixture, createProfileFixture } from '../../test/fixtures/profile.js';
import { allocationAttributes, scopeContext } from '../../test/fixtures/lines.js';
import { setEventPass } from '../../test/helpers/event-pass.js';

test('a population event count includes zero-weight events within ranges and accepted by filters', () => {
    // Events at positions 0, 10, 10, 20, 20, 25 (ends at 25)
    const population = new Population(
        new Uint32Array([0, 1, 0, 1, 0, 1]),
        new Uint32Array([10, 0, 10, 0, 5, 0])
    );
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

    viewport.filter.set({
        key: 'test',
        domain: 'sample',
        size: 2,
        accepts: new Uint8Array([1, 0])
    });
    assert.equal(count(), 3);
    viewport.destroy();
});

test.each([
    {
        name: 'a viewport around the line',
        scopeViewport: { start: 100, end: 200 },
        count: 10,
        intersecting: [0, 0, 1, 2, 2, 0, 0, 0, 0, 0],
        starts: [0, 0, 1, 1, 1, 0, 0, 0, 0, 0]
    },
    {
        name: 'a narrow viewport',
        scopeViewport: { start: 130, end: 140 },
        count: 2,
        intersecting: [1, 1],
        starts: [0, 1]
    }
])('sample counters of $name count intersecting events per bin and visible event starts once', async row => {
    // Events at 125–135, 135–145 and 145–150
    const { breakdown } = await createLineFixture({ origin: 125 });
    const context = scopeContext(breakdown, row.scopeViewport);

    const assertCounts = () => {
        assert.deepEqual(Array.from(methods.countSamples.call({ context }, row.count)), row.intersecting);
        assert.deepEqual(Array.from(methods.countSamplesDiscrete.call({ context }, row.count, undefined)), row.starts);
    };

    // The window counts accepted events of a bin from its records, and from its events in the event pass
    assertCounts();
    setEventPass(breakdown.populationWindow);
    assertCounts();
});

test.each([
    {
        name: 'the line',
        scopeViewport: { start: 125, end: 150 },
        ranges: null,
        accepts: null,
        expected: 3
    },
    {
        name: 'a segment within an event',
        scopeViewport: { start: 127, end: 133 },
        ranges: null,
        accepts: null,
        expected: 1
    },
    {
        name: 'a segment between event edges',
        scopeViewport: { start: 135, end: 145 },
        ranges: null,
        accepts: null,
        expected: 1
    },
    {
        name: 'a segment intersecting less than a unit of an event',
        scopeViewport: { start: 134.5, end: 140 },
        ranges: null,
        accepts: null,
        expected: 2
    },
    {
        name: 'a segment over window ranges',
        scopeViewport: { start: 125, end: 150 },
        ranges: [{ start: 0, end: 12 }],
        accepts: null,
        expected: 2
    },
    {
        name: 'a segment with a sample filter',
        scopeViewport: { start: 125, end: 150 },
        ranges: null,
        accepts: [1, 0],
        expected: 2
    }
])('a single sample bin counts accepted events intersecting $name', async row => {
    // Events at 125–135 (sample 0), 135–145 (sample 1) and 145–150 (sample 0)
    const { breakdown } = await createLineFixture({ origin: 125 });
    const window = breakdown.populationWindow;
    const context = scopeContext(breakdown, row.scopeViewport);

    window.setRanges(row.ranges);
    window.filter.set({
        key: 'samples',
        domain: 'sample',
        size: 2,
        accepts: row.accepts && Uint8Array.from(row.accepts)
    });

    assert.deepEqual(Array.from(methods.countSamples.call({ context }, 1)), [row.expected]);
    setEventPass(window);
    assert.deepEqual(Array.from(methods.countSamples.call({ context }, 1)), [row.expected]);
});

// Allocations of 16, 32, 48 and 64 bytes: 0 and 2 alive, 1 short-lived, 3 long-lived
test('attribute totals are of the dictionary entries of the attribute in a population', async () => {
    const { profile } = await createProfileFixture(allocationAttributes);
    const line = profile.memline!;
    const lifespan = line.attributes.find(attribute => attribute.name === 'allocationLifespan')!;
    const totals = methods.attributeSampleTotals(lifespan, line.breakdowns[0].population);

    assert.deepEqual(totals.filter(entry => entry.count > 0), [
        { entry: 'alive', count: 2, size: 64 },
        { entry: 'short-lived', count: 1, size: 32 },
        { entry: 'long-lived', count: 1, size: 64 }
    ]);
});
