import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import jora from 'jora';
import type { CpuProCompilationRecord, CpuProThread } from '../prepare/types.js';
import { createProfileFixture, createLineFixture } from '../../test/fixtures/profile.js';
import { createProfile } from '../prepare/profile.mjs';
import {
    analyzeEventNesting,
    countInversions,
    isTimed,
    methods,
    sortPlacedEvents
} from './signals.js';

type Interval = [start: number, end: number];

const query = jora.setup({ methods });

function createEvent(name: string, time: Interval, allocations?: Interval): CpuProCompilationRecord {
    const [start, end] = time;

    return {
        name,
        tm: start,
        duration: end - start,
        allocationStart: allocations?.[0] ?? null,
        allocationEnd: allocations?.[1] ?? null,
        scriptId: null,
        start: null,
        end: null,
        line: null,
        column: null,
        functionName: null,
        eventIndex: null,
        event: null,
        callFrame: null
    };
}

function createThread(compilations: CpuProCompilationRecord[]) {
    return { compilations } as unknown as CpuProThread;
}

describe('event analysis', () => {
    test('counts inversions of a vector', () => {
        assert.equal(countInversions([]), 0);
        assert.equal(countInversions([1, 1, 2, 5]), 0);
        assert.equal(countInversions([1, 3, 2, 5, 4]), 2);
    });

    test('sorts events with a known start, outer events first, instant ones included', () => {
        const unplaced = { ...createEvent('Unplaced', [0, 0]), tm: null };
        const sorted = sortPlacedEvents([
            createEvent('Inner', [15, 25]),
            createEvent('Instant', [20, 20]),
            unplaced,
            createEvent('Outer', [10, 40]),
            createEvent('Same start, shorter', [10, 12])
        ]);

        assert.deepEqual(sorted.map(event => event.name), [
            'Outer',
            'Same start, shorter',
            'Inner',
            'Instant'
        ]);
        assert.deepEqual(sorted.filter(isTimed).map(event => event.name), [
            'Outer',
            'Same start, shorter',
            'Inner'
        ]);
    });

    test('flags partial time overlaps and allocation ranges outside the time parent', () => {
        const nesting = analyzeEventNesting(sortPlacedEvents([
            createEvent('Outer', [10, 40], [10, 20]),
            createEvent('Outside', [12, 17], [30, 40]),
            createEvent('Inner', [15, 25], [12, 18]),
            createEvent('Leaks', [20, 50], [15, 25]),
            createEvent('NoAllocations', [100, 110], [5, 5]),
            createEvent('Child', [101, 103], [5, 7])
        ]).filter(isTimed));

        assert.equal(nesting.partialOverlaps, 2);
        assert.equal(nesting.nestedWithAllocations, 4);
        assert.equal(nesting.rangeViolationsCount, 4);
        assert.deepEqual([...nesting.rangeViolations], [
            ['Outer -> Outside', 1],
            ['Outside -> Inner', 1],
            ['Outer -> Leaks', 1],
            ['NoAllocations -> Child (parent has no allocations)', 1]
        ]);
    });
});

describe('measurements', () => {
    test('distributions and coverage preserve independent model categories', async () => {
        const names = ['(idle)', '(garbage collector)', '(external)', 'run', 'extension'];
        const profile = await createProfile({
            startTime: 0, endTime: 60,
            nodes: [
                {
                    id: 1,
                    callFrame: { functionName: '(root)', scriptId: 0, url: '', lineNumber: -1, columnNumber: -1 },
                    children: [2, 3, 4, 5, 6]
                },
                ...names.map((name, index) => ({
                    id: index + 2,
                    callFrame: {
                        functionName: name, scriptId: index < 3 ? 0 : index,
                        url: index === 4 ? 'chrome-extension://fixture/main.js' : index === 3 ? 'https://example.org/main.js' : '',
                        lineNumber: index < 3 ? -1 : 0, columnNumber: index < 3 ? -1 : 0
                    }
                }))
            ],
            samples: [2, 3, 4, 5, 6], timeDeltas: [10, 10, 10, 10, 10]
        });

        profile.thread = createThread([createEvent('Compile', [0, 100])]);

        const distribution = query('sampleDistribution()')(profile);
        const coverage = query('samplesByCompilation()')(profile);
        const expected = ['idle', 'gc', 'internals', 'script', 'chrome-extension'];

        for (const result of [distribution, coverage]) {
            assert.deepEqual(result.categories.filter(entry => entry.total > 0)
                .map(entry => entry.category.name).sort(), expected.toSorted());
            assert.equal(result.bins.length, 500);
            assert.equal(result.categories.reduce((sum, entry) => sum + entry.total, 0), 5);
        }
        assert.equal(distribution.categories.reduce((sum, entry) => sum + entry.value, 0), distribution.value);
        assert.deepEqual(coverage.events.find(event => event.name === 'Compile').counts,
            Uint32Array.from(coverage.categories, entry => entry.total));
    });

    test('distribution preserves byte sums beyond Uint32 and keeps missing categories unknown', async () => {
        const { profile, line } = await createLineFixture({
            type: 'memline', values: Uint32Array.from([0, 1, 2 ** 31, 2 ** 31])
        });

        line.breakdowns = [];
        const result = query('sampleDistribution("memline", 1)')(profile);

        assert.equal(result.count, 4);
        assert.equal(result.value, 2 ** 32 + 1);
        assert.deepEqual([...result.valueBins], [2 ** 32 + 1]);
        assert.equal(result.categories.find(entry => entry.category === null).total, 4);
        assert.equal(result.sizes.reduce((sum, size) => sum + size.count, 0), 4);
        assert.equal(result.sizes.reduce((sum, size) => sum + size.value, 0), 2 ** 32 + 1);
        assert.equal(result.sizes[0].count, 1);
        assert.equal(result.sizes[1].count, 1);
        assert.equal(result.sizes[32].count, 2);
    });

    test('a present but empty population has zero totals and finite bins', async () => {
        const { profile } = await createProfileFixture();

        profile.timeline!.values = new Uint32Array();
        const result = query('sampleDistribution("timeline", 3)')(profile);

        assert.equal(result.count, 0);
        assert.equal(result.value, 0);
        assert.deepEqual([...result.bins], [0, 0, 0]);
        assert.deepEqual([...result.valueBins], [0, 0, 0]);
    });

    test('sample distributions depend only on their own population', async () => {
        const { profile } = await createProfileFixture();

        for (const cpu of [false, true]) {
            for (const allocations of [false, true]) {
                for (const events of [false, true]) {
                    const input = {
                        ...profile,
                        timeline: cpu ? profile.timeline : null,
                        memline: allocations ? profile.memline : null,
                        thread: events ? createThread([createEvent('Compile', [10, 25])]) : null
                    };

                    for (const [type, available] of [['timeline', cpu], ['memline', allocations]]) {
                        const result = query(`sampleDistribution('${type}', 4)`)(input);

                        if (!available) {
                            assert.equal(result, null);
                            continue;
                        }

                        const values = input[type].values;
                        const totalValue = values.reduce((sum, value) => sum + value, 0);

                        assert.equal(result.count, values.length);
                        assert.equal(result.value, totalValue);
                        assert.equal(result.bins.reduce((sum, count) => sum + count, 0), values.length);
                        assert.equal(result.valueBins.reduce((sum, value) => sum + value, 0), totalValue);
                        assert.equal(result.categories.reduce((sum, entry) => sum + entry.total, 0), values.length);
                    }
                }
            }
        }
    });

    test('CPU coverage assigns each sample to one innermost event or outside', async () => {
        const { profile } = await createProfileFixture();

        profile.thread = createThread([
            createEvent('Outer', [10, 30]),
            createEvent('Inner', [20, 25])
        ]);

        const coverage = query('samplesByCompilation()')(profile);

        assert.equal(coverage.categories.reduce((sum, entry) => sum + entry.total, 0), 3);
        assert.equal(coverage.categories.reduce((sum, entry) => sum + entry.outside, 0), 1);
        assert.deepEqual(coverage.events.map(event => [event.name, event.count]), [
            [null, 1], ['Outer', 1], ['Inner', 1]
        ]);
        const script = coverage.categories.find(entry => entry.category?.name === 'script');

        assert.equal(script.bins.reduce((sum, count) => sum + count, 0), 3);
        assert.equal(script.outsideBins.reduce((sum, count) => sum + count, 0), 1);
    });

    test('coverage is unavailable without channels or with crossing events', async () => {
        const { profile } = await createProfileFixture();

        assert.equal(query('samplesByCompilation()')(profile), null);
        assert.equal(query('samplesByCompilation("memline")')(profile), null);
        profile.thread = createThread([
            createEvent('First', [10, 25]), createEvent('Crossing', [20, 30])
        ]);
        assert.equal(query('samplesByCompilation()')(profile), null);
    });

    test('allocation coverage separates boundaries and conserves counts', async () => {
        const { profile } = await createProfileFixture({ mapping: [1, 2, 3] });
        const values = Uint8Array.from([0, 1, 0, 0]);

        profile.memline!.attributes.push({
            name: 'allocationCompilationStage', values, dict: ['none', 'Stage']
        });

        const coverage = query('samplesByCompilation("memline", 2.5)')(profile);
        const total = field => coverage.categories.reduce((sum, entry) => sum + entry[field], 0);

        assert.deepEqual(coverage.window, { start: 1, end: 3 });
        assert.equal(total('total'), 4);
        assert.equal(total('covered'), 1);
        assert.equal(total('outside'), 3);
        assert.equal(total('before'), 1);
        assert.equal(total('after'), 1);
        assert.deepEqual([...coverage.bins], [2, 2]);
        assert.deepEqual([...coverage.outsideBins], [1, 2]);
        assert.deepEqual(coverage.events.map(event => [event.name, event.count]), [
            [null, 3], ['Stage', 1]
        ]);
        for (const event of coverage.events) {
            assert.equal(event.counts.reduce((sum, count) => sum + count, 0), event.count);
        }
        assert.deepEqual([...values], [0, 1, 0, 0]);
    });

    test('allocation boundaries remain unknown when mapped IDs exceed population', async () => {
        const { profile } = await createProfileFixture({ mapping: [1, 3, 9] });

        profile.memline!.attributes.push({
            name: 'allocationCompilationStage',
            values: Uint8Array.from([0, 0, 0, 0]), dict: ['none']
        });
        const coverage = query('samplesByCompilation("memline")')(profile);

        assert.equal(coverage.window, null);
        assert.equal(coverage.categories.reduce((sum, entry) => sum + entry.outside, 0), 4);
    });

    test('coverage uses model categories rather than frame kinds and does not require allocations', async () => {
        const { profile } = await createProfileFixture({ cpuOnly: true });
        const callStack = profile.timeline!.breakdowns.find(item => item.kind === 'call-stack')!;
        const events = [createEvent('Later', [30, 31]), createEvent('Earlier', [10, 11])];

        for (const frame of callStack.callFrames!.tree.dictionary) {
            frame.kind = 'builtin';
        }
        profile.thread = createThread(events);

        const coverage = query('samplesByCompilation()')(profile);
        const script = coverage.categories.find(entry => entry.category?.name === 'script');

        assert.equal(script.total, 3);
        assert.equal(script.covered, 2);
        assert.equal(script.outside, 1);
        assert.deepEqual(events.map(event => event.name), ['Later', 'Earlier']);
        assert.equal(coverage.bins.reduce((sum, count) => sum + count, 0), 3);
        assert.equal(query('samplesByCompilation("memline")')(profile), null);
    });

    test('eventNesting() counts partial overlaps and range violations as numbers', () => {
        const events = [
            createEvent('Outer', [10, 40], [10, 20]),
            createEvent('Leaks', [20, 50], [15, 25]),
            createEvent('Child', [11, 12], [30, 40])
        ];
        const nesting = query('eventNesting()')(events);

        assert.deepEqual(nesting, {
            partialOverlaps: 1,
            nestedWithAllocations: 2,
            rangeViolations: 2
        });
        assert.equal(query('eventNesting()')(events), nesting, 'cached per events array');
        assert.equal(query('eventNesting().partialOverlaps')(events), 1);
    });

    test('inversions() counts neighbours going backwards', () => {
        assert.equal(query('inversions()')([1, 3, 2, 5, 4]), 2);
        assert.equal(query('inversions()')(Uint32Array.from([1, 1, 2])), 0);
        assert.equal(query('inversions()')(null), null);
        assert.equal(query('inversions()')({}), null);
    });

    test('eventNesting() gives null for a value that is not a list of events', () => {
        assert.equal(query('eventNesting()')(null), null);
        assert.equal(query('eventNesting()')({}), null);
    });

    describe('allocationStageMismatches()', () => {
        // the fixture has 4 allocations
        const nested = [
            createEvent('Outer', [0, 100], [0, 3]),
            createEvent('Inner', [10, 20], [1, 2])
        ];

        async function measure(stageByAllocation: number[], mapping = [1, 3, 4], events = nested) {
            const { profile } = await createProfileFixture({ mapping });
            const thread = createThread(events);

            profile.thread = thread as typeof profile.thread;
            profile.memline!.attributes.push({
                name: 'allocationCompilationStage',
                values: Uint8Array.from(stageByAllocation),
                dict: ['none', 'Outer', 'Inner', 'Instant']
            });

            return query('allocationStageMismatches()')(profile, { primaryProfile: null });
        }

        test('is zero when the attribute follows the nesting', async () => {
            assert.equal(await measure([1, 2, 1, 0]), 0);
        });

        test('counts allocations owned by a different stage', async () => {
            assert.equal(await measure([1, 1, 1, 2]), 2);
        });

        test('cannot be judged when ids do not look like 1..N', async () => {
            assert.equal(await measure([1, 2, 1, 0], [1, 3, 9]), null);
        });

        describe('instant events', () => {
            const outer = createEvent('Outer', [0, 100], [0, 3]);

            test('own their allocations inside a parent, including its very end', async () => {
                for (const time of [50, 100]) {
                    const events = [outer, createEvent('Instant', [time, time], [1, 2])];

                    assert.equal(await measure([1, 3, 1, 0], undefined, events), 0, `at ${time}`);
                }
            });

            test('own their allocations outside any parent', async () => {
                const events = [
                    createEvent('Outer', [0, 100], [0, 2]),
                    createEvent('Instant', [200, 200], [3, 4])
                ];

                assert.equal(await measure([1, 1, 0, 3], undefined, events), 0);
            });

            test('are counted when the parent owns their allocations', async () => {
                const events = [outer, createEvent('Instant', [50, 50], [1, 2])];

                assert.equal(await measure([1, 1, 1, 0], undefined, events), 1);
            });

            test('include unfinished events without a duration', async () => {
                const unfinished = { ...createEvent('Instant', [50, 50], [1, 2]), duration: null };

                assert.equal(await measure([1, 3, 1, 0], undefined, [outer, unfinished]), 0);
            });
        });
    });

    test('allocationStageMismatches() is null without a profile', () => {
        assert.equal(
            query('allocationStageMismatches()')(null, { primaryProfile: null, scopeProfile: null }),
            null
        );
    });
});
