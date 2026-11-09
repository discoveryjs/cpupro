import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';

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
