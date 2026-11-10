import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Population, PopulationFiltered } from '../prepare/computations/population.js';
import { methods } from './samples.js';

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
