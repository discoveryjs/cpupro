import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import jora from 'jora';
import type {
    CpuProCompilationRecord,
    CpuProThread,
    V8CpuProfileCallFrame,
    V8CpuProfileNode
} from '../prepare/types.js';
import { createProfileFixture, createLineFixture } from '../../test/fixtures/profile.js';
import { createCompilationRecord } from '../../test/fixtures/compilation.js';
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

// A compilation event outside of any script, placed by its time and allocation intervals
function createEvent(name: string, time: Interval, allocations?: Interval): CpuProCompilationRecord {
    return createCompilationRecord({
        name,
        tm: time[0],
        duration: time[1] - time[0],
        scriptId: null,
        start: null,
        end: null,
        allocationStart: allocations?.[0] ?? null,
        allocationEnd: allocations?.[1] ?? null
    });
}

function createThread(compilations: CpuProCompilationRecord[]) {
    return { compilations } as unknown as CpuProThread;
}

function nativeFrame(functionName: string): V8CpuProfileCallFrame {
    return {
        functionName,
        scriptId: 0,
        url: '',
        lineNumber: -1,
        columnNumber: -1
    };
}

function scriptFrame(functionName: string, scriptId: number, url: string): V8CpuProfileCallFrame {
    return {
        functionName,
        scriptId,
        url,
        lineNumber: 0,
        columnNumber: 0
    };
}

// A CPU profile with a sample of 10us in each of the call frames, in their order
function createSampledProfile(callFrames: V8CpuProfileCallFrame[]) {
    const root: V8CpuProfileNode = { id: 1, callFrame: nativeFrame('(root)'), children: [] };
    const nodes = [root];
    const samples: number[] = [];
    const timeDeltas: number[] = [];

    for (let i = 0; i < callFrames.length; i++) {
        root.children!.push(i + 2);
        nodes.push({ id: i + 2, callFrame: callFrames[i] });
        samples.push(i + 2);
        timeDeltas.push(10);
    }

    return createProfile({
        startTime: 0,
        endTime: callFrames.length * 10,
        nodes,
        samples,
        timeDeltas
    });
}

type SampledCategory = { category: { name: string } | null; total: number };

// Sample counts of the categories with samples, by their names
function countsByCategory(categories: SampledCategory[]) {
    const counts: Record<string, number> = {};

    for (let i = 0; i < categories.length; i++) {
        if (categories[i].total > 0) {
            counts[categories[i].category!.name] = categories[i].total;
        }
    }

    return counts;
}

type DistributionCategory = SampledCategory & { value: number; bins: Uint32Array; valueBins: Float64Array };

// Categories of a distribution as [name, samples, value, bins, value bins]
function describeCategories(categories: DistributionCategory[]) {
    return categories.map(entry => [
        entry.category!.name,
        entry.total,
        entry.value,
        Array.from(entry.bins),
        Array.from(entry.valueBins)
    ]);
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
    test('distributions and coverage count each sample in the model category of its call frame', async () => {
        const profile = await createSampledProfile([
            nativeFrame('(idle)'),
            nativeFrame('(garbage collector)'),
            nativeFrame('(external)'),
            scriptFrame('run', 3, 'https://example.org/main.js'),
            scriptFrame('extension', 4, 'chrome-extension://extension/main.js')
        ]);
        const expected = {
            idle: 1,
            gc: 1,
            internals: 1,
            script: 1,
            'chrome-extension': 1
        };

        profile.thread = createThread([createEvent('Compile', [0, 100])]);
        const distribution = query('sampleDistribution()')(profile);
        const coverage = query('samplesByCompilation()')(profile);

        assert.deepEqual(countsByCategory(distribution.categories), expected);
        assert.deepEqual(countsByCategory(coverage.categories), expected);
        assert.deepEqual(coverage.events.map(event => [event.name, event.count]), [[null, 0], ['Compile', 5]]);
    });

    test.each([
        ['undefined', 500],
        ['3', 3],
        ['2.7', 2],
        ['0', 500],
        ['-5', 1],
        ['2000', 1000],
        ['NaN', 500]
    ])('distributions and coverage of %s bins have %i bins', async (binCount, length) => {
        const { profile } = await createProfileFixture();

        profile.thread = createThread([createEvent('Compile', [10, 25])]);
        const distribution = query(`sampleDistribution("timeline", ${binCount})`)(profile);
        const coverage = query(`samplesByCompilation("timeline", ${binCount})`)(profile);

        assert.equal(distribution.bins.length, length);
        assert.equal(distribution.valueBins.length, length);
        assert.equal(coverage.bins.length, length);
        assert.equal(coverage.outsideBins.length, length);
    });

    // The timeline has 3 samples of 10us from 10us, the memline 4 allocations of 16, 32, 48 and 64 bytes, the last
    // of them without a location; allocations are binned by their index
    test.each([
        {
            type: 'timeline',
            axis: [10, 40],
            count: 3,
            value: 30,
            bins: [1, 1, 1, 0],
            valueBins: [10, 10, 10, 0],
            categories: [
                ['root', 0, 0, [0, 0, 0, 0], [0, 0, 0, 0]],
                ['script', 3, 30, [1, 1, 1, 0], [10, 10, 10, 0]]
            ]
        },
        {
            type: 'memline',
            axis: [0, 4],
            count: 4,
            value: 160,
            bins: [1, 1, 1, 1],
            valueBins: [16, 32, 48, 64],
            categories: [
                ['root', 0, 0, [0, 0, 0, 0], [0, 0, 0, 0]],
                ['unknown', 1, 64, [0, 0, 0, 1], [0, 0, 0, 64]],
                ['script', 3, 96, [1, 1, 1, 0], [16, 32, 48, 0]]
            ]
        }
    ])('a distribution of the $type bins its samples and values over its axis by category', async row => {
        const { profile } = await createProfileFixture();
        const result = query(`sampleDistribution("${row.type}", 4)`)(profile);

        assert.deepEqual([result.start, result.end], row.axis);
        assert.equal(result.count, row.count);
        assert.equal(result.value, row.value);
        assert.deepEqual(Array.from(result.bins), row.bins);
        assert.deepEqual(Array.from(result.valueBins), row.valueBins);
        assert.deepEqual(describeCategories(result.categories), row.categories);
    });

    test('a zero-weight sample at the end of the timeline is in the last bin', async () => {
        const { profile } = await createLineFixture({ values: new Uint32Array([10, 10, 0]) });
        const result = query('sampleDistribution("timeline", 2)')(profile);

        assert.deepEqual([result.start, result.end], [0, 20]);
        assert.deepEqual(Array.from(result.bins), [1, 2]);
        assert.deepEqual(Array.from(result.valueBins), [10, 10]);
    });

    test.each([
        ['timeline', 'memline'],
        ['memline', 'timeline']
    ] as const)('a distribution of the %s does not depend on the %s or compilation events', async (type, other) => {
        const { profile } = await createProfileFixture();
        const distribution = query(`sampleDistribution("${type}", 4)`);
        const withEvents = { ...profile, thread: createThread([createEvent('Compile', [10, 25])]) };
        const withoutOther = { ...profile, [other]: null };

        assert.deepEqual(distribution(withEvents), distribution(profile));
        assert.deepEqual(distribution(withoutOther), distribution(profile));
    });

    test.each(['timeline', 'memline'])('there is no distribution of a profile without its %s', async type => {
        const { profile } = await createProfileFixture();

        assert.equal(query(`sampleDistribution("${type}")`)({ ...profile, [type]: null }), null);
    });

    test('there is no distribution or coverage without a profile or of another line type', async () => {
        const { profile } = await createProfileFixture();
        const noProfile = { primaryProfile: null, scopeProfile: null };

        assert.equal(query('sampleDistribution()')(null, noProfile), null);
        assert.equal(query('samplesByCompilation()')(null, noProfile), null);
        assert.equal(query('sampleDistribution("events")')(profile), null);
        assert.equal(query('samplesByCompilation("events")')(profile), null);
    });

    test('distribution preserves byte sums beyond Uint32 and keeps missing categories unknown', async () => {
        const { profile, line } = await createLineFixture({
            type: 'memline',
            values: Uint32Array.from([0, 1, 2 ** 31, 2 ** 31])
        });

        line.breakdowns = [];
        const result = query('sampleDistribution("memline", 1)')(profile);

        assert.equal(result.count, 4);
        assert.equal(result.value, 2 ** 32 + 1);
        assert.deepEqual([...result.valueBins], [2 ** 32 + 1]);
        assert.equal(result.categories.length, 1);
        assert.equal(result.categories[0].category, null);
        assert.equal(result.categories[0].total, 4);
        assert.equal(result.sizes.length, 33);
        assert.deepEqual(result.sizes.filter(size => size.count > 0), [
            { min: 0, max: 1, count: 1, value: 0 },
            { min: 1, max: 2, count: 1, value: 1 },
            { min: 2 ** 31, max: 2 ** 32, count: 2, value: 2 ** 32 }
        ]);
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
            createEvent('First', [10, 25]),
            createEvent('Crossing', [20, 30])
        ]);
        assert.equal(query('samplesByCompilation()')(profile), null);
    });

    test('allocation coverage separates boundaries and conserves counts', async () => {
        const { profile } = await createProfileFixture({ mapping: [1, 2, 3] });
        const values = Uint8Array.from([0, 1, 0, 0]);

        profile.memline!.attributes.push({
            name: 'allocationCompilationStage',
            values,
            dict: ['none', 'Stage']
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
        for (let i = 0; i < coverage.events.length; i++) {
            const event = coverage.events[i];

            assert.equal(event.counts.reduce((sum, count) => sum + count, 0), event.count);
        }
        assert.deepEqual([...values], [0, 1, 0, 0]);
    });

    test('the CPU window includes the allocation at its start and excludes the one at its end', async () => {
        const { profile } = await createProfileFixture({ mapping: [1, 2, 3] });

        profile.memline!.attributes.push({
            name: 'allocationCompilationStage',
            values: Uint8Array.from([0, 0, 0, 0]),
            dict: ['none']
        });
        const coverage = query('samplesByCompilation("memline")')(profile);
        const script = coverage.categories.find(entry => entry.category?.name === 'script');
        const unknown = coverage.categories.find(entry => entry.category?.name === 'unknown');

        assert.deepEqual(coverage.window, { start: 1, end: 3 });
        assert.deepEqual([script.outside, script.before, script.after], [3, 1, 0]);
        assert.deepEqual([unknown.outside, unknown.before, unknown.after], [1, 0, 1]);
    });

    test('allocation boundaries remain unknown when mapped IDs exceed population', async () => {
        const { profile } = await createProfileFixture({ mapping: [1, 3, 9] });

        profile.memline!.attributes.push({
            name: 'allocationCompilationStage',
            values: Uint8Array.from([0, 0, 0, 0]),
            dict: ['none']
        });
        const coverage = query('samplesByCompilation("memline")')(profile);

        assert.equal(coverage.window, null);
        assert.equal(coverage.categories.reduce((sum, entry) => sum + entry.outside, 0), 4);
    });

    test('coverage uses model categories rather than frame kinds and does not require allocations', async () => {
        const { profile } = await createProfileFixture({ cpuOnly: true });
        const callStack = profile.timeline!.breakdowns.find(item => item.kind === 'call-stack')!;
        const events = [createEvent('Later', [30, 31]), createEvent('Earlier', [10, 11])];

        const frames = callStack.callFrames!.tree.dictionary;

        for (let i = 0; i < frames.length; i++) {
            frames[i].kind = 'builtin';
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
