import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { mapAllocationsToSamples, mapLineRanges } from './line-mapping.js';

test('maps time by sample timestamps and allocation ranges by overlapping occurrences', async () => {
    const { profile } = await createProfileFixture({ startTime: 100 });
    const time = profile.timeline!;
    const allocations = profile.memline!;
    for (const [range, expected] of [
        [{ start: 120, end: 130 }, [{ start: 16, end: 96 }]],
        [{ start: 121, end: 129 }, []],
        [{ start: 105, end: 120 }, [{ start: 0, end: 16 }]],
        [{ start: 130, end: 200 }, [{ start: 96, end: 160 }]],
        [{ start: 0, end: 105 }, []]
    ] as const) {
        assert.deepEqual(mapLineRanges(time, allocations, [range]), expected);
    }
    for (const range of [{ start: 16, end: 48 }, { start: 48, end: 96 }, { start: 20, end: 25 }]) {
        const request = [range];
        assert.deepEqual(mapLineRanges(allocations, time, request), [{ start: 120, end: 130 }]);
        assert.deepEqual(request, [range]);
    }
    assert.deepEqual(mapLineRanges(allocations, time, [{ start: 160, end: 200 }]), []);
    assert.deepEqual(mapLineRanges(allocations, time, [{ start: -10, end: 0 }]), []);
    assert.deepEqual(mapLineRanges(time, allocations, [{ start: 110, end: 120 }, { start: 130, end: 140 }]), [
        { start: 0, end: 16 }, { start: 96, end: 160 }
    ]);
});

test('maps each byte interval as a whole without adding gaps from samples with no allocations', async () => {
    const { profile } = await createProfileFixture({ mapping: [1, 1, 4] });
    const time = profile.timeline!;
    const allocations = profile.memline!;
    assert.deepEqual(mapLineRanges(allocations, time, [{ start: 0, end: 160 }]), [
        { start: 10, end: 40 }
    ]);
    assert.deepEqual(mapLineRanges(allocations, time, [{ start: 0, end: 16 }, { start: 96, end: 160 }]), [
        { start: 10, end: 20 }, { start: 30, end: 40 }
    ]);
});

test('passes unrestricted and empty requests through, and cannot map lines without an allocation mapping', async () => {
    const { profile } = await createProfileFixture();
    const { profile: unmapped } = await createProfileFixture({ locationsOnly: true });

    assert.equal(mapLineRanges(profile.timeline!, profile.memline!, null), null);
    assert.deepEqual(mapLineRanges(profile.timeline!, profile.memline!, []), []);
    assert.equal(mapLineRanges(unmapped.timeline!, unmapped.memline!, null), undefined);
    assert.equal(mapLineRanges(profile.timeline!, unmapped.memline!, [{ start: 0, end: 40 }]), undefined);
});

// The last sample of the fixture records allocation 3, so allocation 4 (bytes 96–160) is recorded after it and
// maps to the sample after the recorded ones, which the profile adds with no time at its end
test('allocations after the last sample map to the sample after the recorded ones', async () => {
    const { profile } = await createProfileFixture({ mapping: [1, 2, 3] });
    const time = profile.timeline!;
    const allocations = profile.memline!;
    const sampled = mapLineRanges(allocations, time, [{ start: 0, end: 96 }]);

    assert.deepEqual([...mapAllocationsToSamples([1, 2, 3, 4], Uint32Array.of(1, 2, 3), 3)], [0, 1, 2, 3]);
    assert.deepEqual([...allocations.mappings.timeline._mapping], [0, 1, 2, 3]);
    assert.deepEqual(mapLineRanges(allocations, time, [{ start: 96, end: 160 }]), []);
    assert.deepEqual(mapLineRanges(allocations, time, [{ start: 0, end: 160 }]), sampled);
    assert.deepEqual(mapLineRanges(time, allocations, [{ start: 0, end: 40 }]), [{ start: 0, end: 96 }]);
    // A range past the end of the recording covers the instant of its end
    assert.deepEqual(mapLineRanges(time, allocations, [{ start: 0, end: 1000 }]), [{ start: 0, end: 160 }]);
});
