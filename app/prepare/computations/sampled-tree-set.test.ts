import assert from 'node:assert/strict';
import { inject, test } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { noopWorkHandler } from '../misc/work.js';
import { createSampledTreeSet } from './sampled-tree-set.js';

test('keeps the caller tree source, and the profile dictionary when usage dictionaries are off', async () => {
    const { profile, dictionary } = await createProfileFixture({ cpuOnly: true });
    const { source } = profile.timeline!.breakdowns[0];
    const trees = await createSampledTreeSet(dictionary, source, noopWorkHandler);

    assert.equal(trees.source, source);
    if (!inject('useUsage')) {
        assert.equal(trees.dictionary, dictionary);
    }
});
