import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { createLineFixture, createProfileFixture } from '../../../test/fixtures/profile.js';
import { findBreakdown } from '../../../test/fixtures/lines.js';
import { sum } from '../../../test/helpers/values.js';
import { createSampleBreakdown } from './metrics.js';

afterEach(() => {
    vi.restoreAllMocks();
});

test('filtered metrics of every breakdown of a population follow its changes when they are read', async () => {
    const { profile } = await createProfileFixture();
    // A source-mapped breakdown shares the population of its original, the location breakdown has its own
    const original = findBreakdown(profile.memline!, 'call-stack');
    const mapped = findBreakdown(profile.memline!, 'call-stack-sm');
    const other = findBreakdown(profile.memline!, 'location');
    const population = original.populationFiltered;
    const notifications = { mapped: 0, other: 0 };
    const sampleCount = population.samplesMask.length;
    const accepts = new Uint8Array(sampleCount).fill(1);

    mapped.callFrames!.filtered.dict.subscribe(() => notifications.mapped++);
    other.callFrames!.filtered.dict.subscribe(() => notifications.other++);
    accepts[0] = 0;
    population.filter.set({
        key: 'samples',
        domain: 'sample',
        size: sampleCount,
        accepts
    });

    assert.deepEqual(notifications, { mapped: 1, other: 0 });
    for (const breakdown of [original, mapped]) {
        const { dict, nodes } = breakdown.callFrames!.filtered;

        assert.equal(sum(dict.entries.map(entry => entry.selfValue)), sum(population.samplesTotal));
        assert.equal(sum(nodes.selfValues), sum(population.samplesTotal));
        assert.equal(dict.totalValues.length, dict.dictionary.length);
    }

    population.filter.remove('samples');

    const { all, filtered } = original.callFrames!;

    assert.deepEqual([...filtered.dict.selfValues], [...all.dict.selfValues]);
});

test('a kept dictionary entry is current after a change without reading the entries again', async () => {
    const { profile } = await createProfileFixture();
    const breakdown = findBreakdown(profile.memline!, 'call-stack');
    const population = breakdown.populationFiltered;
    const { dict } = breakdown.callFrames!.filtered;
    const entries = dict.entries;
    const kept = entries.map(entry => entry.selfValue);
    const sampleCount = population.samplesMask.length;

    population.filter.set({
        key: 'samples',
        domain: 'sample',
        size: sampleCount,
        accepts: new Uint8Array(sampleCount)
    });

    // The kept entries are read before anything reads the dictionary
    for (let i = 0; i < entries.length; i++) {
        assert.equal(entries[i].selfValue, 0);
        assert.equal(entries[i].totalValue, 0);
        assert.equal(entries[i].samples, 0);
    }

    assert.ok(kept.some(value => value > 0));
    assert.equal(dict.entries, entries);
    // Jora reads own properties: the fields of an entry are its own enumerable properties, in any order
    assert.deepEqual(Object.keys(entries[0]).sort(), [
        'entry',
        'entryIndex',
        'nestedValue',
        'samples',
        'selfValue',
        'totalValue'
    ]);

    population.filter.remove('samples');

    assert.deepEqual(entries.map(entry => entry.selfValue), kept);
});

test('cumulative values, totals and tree metrics stay exact beyond 2^32', async () => {
    const { breakdown } = await createLineFixture({
        type: 'memline',
        values: Uint32Array.of(0xffffffff, 0xffffffff, 0xffffffff, 5),
        samples: Uint32Array.of(0, 1, 0, 1)
    });
    const { population, populationFiltered } = breakdown;
    const total = 3 * 0xffffffff + 5;
    const rootTotal = (nodes: { selfValues: Float64Array; nestedValues: Float64Array }) =>
        nodes.selfValues[0] + nodes.nestedValues[0];

    assert.deepEqual([...population.cumulative], [0, 0xffffffff, 2 * 0xffffffff, 3 * 0xffffffff]);
    assert.equal(population.cumulativeEnd, total);
    assert.deepEqual([...population.samplesTotal], [2 * 0xffffffff, 0xffffffff + 5]);
    assert.equal(rootTotal(breakdown.callFrames!.all.nodes), total);
    assert.equal(sum(breakdown.callFrames!.all.dict.selfValues), total);

    // A range from the middle of the second event to the end of the line
    populationFiltered.setRange(0xffffffff + 10, total);
    assert.deepEqual([...populationFiltered.samplesTotal], [0xffffffff, 0xffffffff - 10 + 5]);
    assert.equal(rootTotal(breakdown.callFrames!.filtered.nodes), total - 0xffffffff - 10);
    assert.equal(sum(breakdown.callFrames!.filtered.dict.selfValues), total - 0xffffffff - 10);

    const aggregated = populationFiltered.aggregateBy(Uint8Array.of(0, 0, 1, 1), 2);

    assert.deepEqual(aggregated.samplesTotal, Float64Array.of(0xffffffff - 10, 0xffffffff + 5));
});

// A browser keeps about a hundred WASM memories alive at once, while a trace has a breakdown or more per profile
test('metrics of any number of breakdowns are computed through one WASM memory', async () => {
    const { profile } = await createProfileFixture();
    const breakdown = findBreakdown(profile.memline!, 'call-stack');
    const population = breakdown.populationFiltered;
    const { nodes } = breakdown.callFrames!.filtered;
    const sampledTree = {
        tree: nodes.tree,
        sampleToNode: nodes.sampleToNode
    };
    const memories = vi.spyOn(WebAssembly, 'Memory');
    const accepts = new Uint8Array(population.samplesMask.length).fill(1);
    const breakdowns = [];

    for (let i = 0; i < 200; i++) {
        breakdowns.push(createSampleBreakdown(population, [sampledTree]));
    }

    accepts[0] = 0;
    population.filter.set({
        key: 'samples',
        domain: 'sample',
        size: accepts.length,
        accepts
    });

    for (let i = 0; i < breakdowns.length; i++) {
        assert.equal(sum(breakdowns[i].dimensions[0].tree.filtered.selfValues), sum(population.samplesTotal));
    }

    assert.ok(memories.mock.calls.length <= 1);
});
