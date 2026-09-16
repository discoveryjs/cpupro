import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../test/fixtures/profile.js';
import { subscribeSelectionSync } from './selection-sync.js';

test('synchronizes through time without feeding a lossy projection back to its source', async () => {
    const { profile: first } = await createProfileFixture({ startTime: 100 });
    const { profile: second } = await createProfileFixture({ startTime: 110 });
    const { profile: absent } = await createProfileFixture({ startTime: 300 });
    const { profile: unmapped } = await createProfileFixture({ locationsOnly: true });
    const profiles = [first, second, absent, unmapped];
    const source = first.memline!.range;
    const time = first.timeline!.range;
    const selections = profiles.flatMap(profile => profile.lines.map(line => line.range.selection));
    assert.equal(new Set(selections).size, selections.length);
    const snapshots = profiles.flatMap(profile => profile.lines.flatMap(line => line.breakdowns.map(breakdown => ({
        breakdown, tree: breakdown.callFrames!.tree, values: breakdown.populationFiltered.values,
        cumulative: breakdown.populationFiltered.cumulative, base: Array.from(breakdown.population.values)
    }))));
    let changes = 0;
    time.subscribe(() => changes++);
    const stop = subscribeSelectionSync(profiles, () => profiles);
    source.setRange(20, 25);
    assert.deepEqual(source.ranges, [{ start: 20, end: 25 }]);
    assert.deepEqual(time.selection.ranges, [{ start: 120, end: 130 }]);
    assert.deepEqual(second.memline!.range.ranges, [{ start: 0, end: 16 }]);
    assert.deepEqual(absent.timeline!.range.selection.ranges, [{ start: 120, end: 130 }]);
    assert.deepEqual(absent.timeline!.range.coverage, []);
    assert.deepEqual(absent.memline!.range.ranges, []);
    assert.equal(unmapped.memline!.range.ranges, null);
    for (const breakdown of first.memline!.breakdowns) {
        const metrics = breakdown.callFrames!.filtered.nodes;
        assert.equal(metrics.selfValues[0] + metrics.nestedValues[0], 5);
    }

    time.selection.setRange(120, 130);
    assert.equal(changes, 1);
    assert.deepEqual(source.ranges, [{ start: 16, end: 96 }]);
    source.setRanges([]);
    assert.ok(profiles.every(profile => profile.timeline!.range.ranges?.length === 0));
    second.timeline!.range.resetRange();
    assert.ok(selections.filter(selection => selection !== unmapped.memline!.range.selection).every(selection => selection.ranges === null));
    for (const { breakdown, tree, values, cumulative, base } of snapshots) {
        assert.equal(breakdown.callFrames!.tree, tree);
        assert.equal(breakdown.populationFiltered.values, values);
        assert.equal(breakdown.populationFiltered.cumulative, cumulative);
        assert.deepEqual(Array.from(breakdown.population.values), base);
    }
    stop();
    source.setRange(0, 16);
    assert.equal(time.ranges, null);
});

test('uses the current peer set rather than fixing a bucket relation during preparation', async () => {
    const { profile: first } = await createProfileFixture();
    const { profile: second } = await createProfileFixture();
    const { profile: third } = await createProfileFixture();
    let peers = [first, second];
    const stop = subscribeSelectionSync([first, second, third], source => peers.includes(source) ? peers : []);
    first.timeline!.range.setRange(0, 10);
    assert.equal(third.timeline!.range.ranges, null);
    peers = [second, third];
    third.timeline!.range.setRange(10, 20);
    assert.deepEqual(second.timeline!.range.ranges, [{ start: 10, end: 20 }]);
    assert.deepEqual(first.timeline!.range.ranges, [{ start: 0, end: 10 }]);
    stop();
});
