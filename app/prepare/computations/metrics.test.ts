import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLineFixture, createProfileFixture } from '../../../test/fixtures/profile.js';

test('filtered metrics of every breakdown of a population follow its changes when they are read', async () => {
    const { profile } = await createProfileFixture();
    const breakdown = (kind: string) => profile.memline!.breakdowns.find(breakdown => breakdown.kind === kind)!;
    // A source-mapped breakdown shares the population of its original, the location breakdown has its own
    const [original, mapped, other] = [breakdown('call-stack'), breakdown('call-stack-sm'), breakdown('location')];
    const population = original.populationFiltered;
    const included = () => population.samplesTotal.reduce((sum, value) => sum + value, 0);
    const notifications = { mapped: 0, other: 0 };

    mapped.callFrames!.filtered.dict.subscribe(() => notifications.mapped++);
    other.callFrames!.filtered.dict.subscribe(() => notifications.other++);
    population.updateMask(mask => {
        mask[0] = 1;
    });

    assert.deepEqual(notifications, { mapped: 1, other: 0 });
    for (const { callFrames } of [original, mapped]) {
        const { dict, nodes } = callFrames!.filtered;

        assert.equal(dict.entries.reduce((sum, entry) => sum + entry.selfValue, 0), included());
        assert.equal(nodes.selfValues.reduce((sum, value) => sum + value, 0), included());
        assert.equal(dict.totalValues.length, dict.dictionary.length);
    }

    population.updateMask(mask => {
        mask[0] = 0;
    });

    assert.deepEqual([...original.callFrames!.filtered.dict.selfValues], [...original.callFrames!.all.dict.selfValues]);
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
