import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { getCategoryOptions, setCategoryEnabled, resetCategoryFilter } from './population-filter.js';

test('category controls update shared breakdowns, preserve range and other mask bits, and restore all data', async () => {
    const { profile } = await createProfileFixture({ contexts: [1, 2, 1, 0] });
    const original = profile.memline!.breakdowns.find(breakdown => breakdown.kind === 'location')!;
    const mapped = profile.memline!.breakdowns.find(breakdown => breakdown.kind === 'location-sm')!;
    const population = original.populationFiltered;
    const options = getCategoryOptions(original);
    assert.ok(options.length > 1);
    assert.ok(options.every(option => option.checked));
    population.setRange(5, 100);
    for (const option of options) {
        setCategoryEnabled(original, option.category, false);
    }
    assert.equal(population.samplesTotal.reduce((sum, value) => sum + value, 0), 0);
    assert.equal(population.sink.total, 95);
    assert.ok(getCategoryOptions(mapped).every(option => !option.checked));
    for (const breakdown of [original, mapped]) {
        const metrics = breakdown.callFrames!.filtered.nodes;
        assert.equal(metrics.selfValues[0] + metrics.nestedValues[0], 0);
    }

    population.updateMask(mask => {
        mask[0] |= 2;
    });
    resetCategoryFilter(mapped);
    assert.equal(population.samplesMask[0], 2);
    assert.ok(getCategoryOptions(original).every(option => option.checked));
    assert.equal(population.rangeStart, 5);
    assert.equal(population.rangeEnd, 100);
    population.updateMask(mask => {
        mask[0] &= ~2;
    });
    assert.equal(population.samplesTotal.reduce((sum, value) => sum + value, 0), 95);
    assert.equal(population.sink.total, 0);
    population.resetRange();
    assert.deepEqual(population.samplesTotal, population.population.samplesTotal);
});
