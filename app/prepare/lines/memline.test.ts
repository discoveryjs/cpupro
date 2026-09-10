import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { noopWorkHandler } from '../misc/work.js';
import { createMemline } from './memline.mjs';

test('keeps allocation locations without creating a borrowed call stack when CPU samples are absent', async () => {
    const { dictionary, scriptsMap } = await createProfileFixture({ cpuOnly: true });
    const line = await createMemline({
        startTime: 0,
        endTime: 0,
        nodes: [],
        samples: [],
        timeDeltas: [],
        _cpuproAllocationMapping: [],
        _cpuproAllocationIds: [1, 2],
        _cpuproAllocationSizes: [16, 32],
        _cpuproAllocationScriptIds: [1, 1],
        _cpuproAllocationLocations: [10, 20]
    }, dictionary, scriptsMap, null, null, Promise.resolve(), { work: noopWorkHandler });

    assert.ok(line);
    assert.deepEqual(line.breakdowns.map(breakdown => breakdown.kind), ['location']);
    assert.deepEqual([...line.values], [16, 32]);
    assert.equal(line.breakdowns[0].population.values, line.values);
});
