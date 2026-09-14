import assert from 'node:assert/strict';
import { test } from 'vitest';
import { methods } from './index.mjs';
import { createProfileFixture } from '../../test/fixtures/profile.js';

test.each([{ mapping: [1, 3, 4] }, { mapping: [0, 4, 4] }, { mapping: [4, 4, 4] }])('excludes sink at the end of or inside a tree mapping: $mapping', async ({ mapping }) => {
    const { profile } = await createProfileFixture({ mapping });
    const line = profile.memline!;
    const breakdown = line.breakdowns.find(entry => entry.kind === 'call-stack')!;
    line.attributes.push(
        { name: 'allocationType', values: new Uint32Array([0, 0, 0, 0]), dict: ['object'] },
        { name: 'allocationLifespan', values: new Uint8Array([0, 0, 0, 0]), dict: ['alive'] }
    );
    const population = breakdown.populationFiltered;
    const matrix = () => methods.allocationsMatrix.call(
        { context: {} }, breakdown.callFrames!.filtered.nodes, population, () => true, profile
    );
    assert.equal(matrix()[0].total.sum, 160);
    population.updateMask(mask => {
        mask[0] = 0x80000000;
    });
    const accepted = population.population.values.reduce((sum, value, index) =>
        sum + (population.population.samples[index] === 0 ? 0 : value), 0
    );
    assert.equal(matrix()[0]?.total.sum ?? 0, accepted);
    population.updateMask(mask => mask.fill(0x80000000));
    assert.deepEqual(matrix(), []);
    assert.equal(population.sink.total, 160);
    population.resetMask();
    assert.equal(matrix()[0].total.sum, 160);
});
