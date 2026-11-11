import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../test/fixtures/profile.js';
import { subscribeSelectionSync } from './selection-sync.js';

// Profiles starting at 100 and 110, one after the samples of the others and one without a time mapping of bytes
async function createPeers() {
    const { profile: first } = await createProfileFixture({ startTime: 100 });
    const { profile: second } = await createProfileFixture({ startTime: 110 });
    const { profile: absent } = await createProfileFixture({ startTime: 300 });
    const { profile: unmapped } = await createProfileFixture({ locationsOnly: true });
    const profiles = [first, second, absent, unmapped];
    const stop = subscribeSelectionSync(profiles, () => profiles);

    return {
        first,
        second,
        absent,
        unmapped,
        stop
    };
}

test('a bytes range reaches time lines of peers through the time line of its profile, and their bytes', async () => {
    const { first, second, absent, unmapped, stop } = await createPeers();

    first.memline!.range.setRange(20, 25);

    assert.deepEqual(first.memline!.range.ranges, [{ start: 20, end: 25 }]);
    assert.deepEqual(first.timeline!.range.selection.ranges, [{ start: 120, end: 130 }]);
    assert.deepEqual(second.timeline!.range.selection.ranges, [{ start: 120, end: 130 }]);
    assert.deepEqual(second.memline!.range.ranges, [{ start: 0, end: 16 }]);
    // A peer outside the time range keeps the request without coverage
    assert.deepEqual(absent.timeline!.range.selection.ranges, [{ start: 120, end: 130 }]);
    assert.deepEqual(absent.timeline!.range.coverage, []);
    assert.deepEqual(absent.memline!.range.ranges, []);
    assert.equal(unmapped.memline!.range.ranges, null);
    // The populations of the source follow its range
    const breakdowns = first.memline!.breakdowns;

    for (let i = 0; i < breakdowns.length; i++) {
        const metrics = breakdowns[i].callFrames!.filtered.nodes;

        assert.equal(metrics.selfValues[0] + metrics.nestedValues[0], 5);
    }
    stop();
});

test('a projection is not fed back to its source, a later request of the time line projects to bytes', async () => {
    const { first, stop } = await createPeers();
    const time = first.timeline!.range;
    let timeChanges = 0;

    time.subscribe(() => timeChanges++);
    first.memline!.range.setRange(20, 25);
    assert.deepEqual(first.memline!.range.ranges, [{ start: 20, end: 25 }]);
    assert.equal(timeChanges, 1);

    time.selection.setRange(120, 130);
    assert.equal(timeChanges, 1);
    assert.deepEqual(first.memline!.range.ranges, [{ start: 16, end: 96 }]);
    stop();
});

test('an empty request and a reset reach the selections of every mapped line', async () => {
    const { first, second, absent, unmapped, stop } = await createPeers();
    const mapped = [...[first, second, absent].flatMap(profile => profile.lines), unmapped.timeline!];

    first.memline!.range.setRanges([]);
    assert.deepEqual(mapped.map(line => line.range.selection.ranges), mapped.map(() => []));

    second.timeline!.range.resetRange();
    assert.deepEqual(mapped.map(line => line.range.selection.ranges), mapped.map(() => null));
    assert.equal(unmapped.memline!.range.selection.ranges, null);
    stop();
});

test('stopping detaches the synchronization', async () => {
    const { first, stop } = await createPeers();

    stop();
    first.memline!.range.setRange(0, 16);
    assert.equal(first.timeline!.range.ranges, null);
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

test('shares viewports and zooms of peer profiles through time, a new viewport ends the zoom of each', async () => {
    const { profile: first } = await createProfileFixture({ startTime: 100 });
    const { profile: second } = await createProfileFixture({ startTime: 110 });
    const { profile: other } = await createProfileFixture({ startTime: 120 });
    const stop = subscribeSelectionSync([first, second, other], profile => profile === other ? [] : [first, second]);

    first.timeline!.viewport.selection.setRange(110, 140);
    assert.deepEqual(second.timeline!.viewport.selection.ranges, [{ start: 110, end: 140 }]);
    assert.equal(other.timeline!.viewport.selection.ranges, null);
    // Bytes follow through the time line of their profile
    for (const profile of [first, second]) {
        assert.ok(profile.memline!.viewport.selection.ranges!.length > 0);
    }
    assert.equal(other.memline!.viewport.selection.ranges, null);

    second.timeline!.zoom.selection.setRange(115, 125);
    assert.deepEqual(first.timeline!.zoom.selection.ranges, [{ start: 115, end: 125 }]);
    assert.deepEqual(first.timeline!.viewport.selection.ranges, [{ start: 110, end: 140 }]);
    assert.notEqual(first.memline!.zoom.selection.ranges, null);

    first.timeline!.viewport.selection.setRange(100, 130);
    for (const profile of [first, second]) {
        assert.deepEqual(profile.timeline!.viewport.selection.ranges, [{ start: 100, end: 130 }]);
        assert.equal(profile.timeline!.zoom.selection.ranges, null);
        assert.equal(profile.memline!.zoom.selection.ranges, null);
    }

    stop();
    first.timeline!.viewport.selection.setRange(110, 120);
    assert.deepEqual(second.timeline!.viewport.selection.ranges, [{ start: 100, end: 130 }]);
});
