import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLineFixture, createProfileFixture } from '../../../test/fixtures/profile.js';

test('filtered breakdown metrics follow population changes when they are read', async () => {
    const { profile } = await createProfileFixture();
    const line = profile.memline!;
    const [first, second] = line.breakdowns;
    const population = first.populationFiltered;
    const expectedTotal = () => population.samplesTotal.reduce((sum, value) => sum + value, 0);
    let notifications = 0;

    second.callFrames.filtered.dict.subscribe(() => notifications++);
    population.updateMask(mask => {
        mask[0] = 1;
    });

    assert.equal(notifications, second.populationFiltered === population ? 1 : 0);
    for (const breakdown of [first, second].filter(breakdown => breakdown.populationFiltered === population)) {
        const { dict, nodes } = breakdown.callFrames.filtered;
        const selfTotal = dict.entries.reduce((sum, entry) => sum + entry.selfValue, 0);

        assert.equal(selfTotal, expectedTotal());
        assert.equal(nodes.selfValues.reduce((sum, value) => sum + value, 0), expectedTotal());
        assert.equal(dict.totalValues.length, dict.dictionary.length);
    }

    population.updateMask(mask => {
        mask[0] = 0;
    });
    const { dict } = first.callFrames.filtered;

    assert.equal(dict.entries.reduce((sum, entry) => sum + entry.selfValue, 0), expectedTotal());
    assert.deepEqual([...dict.selfValues], [...first.callFrames.all.dict.selfValues]);
});

test('cumulative values, totals and tree metrics stay exact beyond 2^32', async () => {
    const values = Uint32Array.of(0xffffffff, 0xffffffff, 0xffffffff, 5);
    const { breakdown } = await createLineFixture({ type: 'memline', values, samples: Uint32Array.of(0, 1, 0, 1) });
    const { population, populationFiltered } = breakdown;
    const total = 3 * 0xffffffff + 5;
    const sum = (array: ArrayLike<number>) => Array.prototype.reduce.call(array, (sum: number, value: number) => sum + value, 0);
    const rootTotal = (nodes: { selfValues: Float64Array; nestedValues: Float64Array }) => nodes.selfValues[0] + nodes.nestedValues[0];

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
    assert.deepEqual(populationFiltered.aggregateBy(Uint8Array.of(0, 0, 1, 1), 2).samplesTotal, Float64Array.of(0xffffffff - 10, 0xffffffff + 5));
});
