import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import jora from 'jora';
import type { CpuProCompilationRecord, CpuProThread } from '../prepare/types.js';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import {
    analyzeEventNesting,
    checkSignalIntegrity,
    countInversions,
    methods,
    sortTimedEvents,
    type SignalCheck
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

function checksById(checks: SignalCheck[]) {
    return Object.fromEntries(checks.map(check => [check.id, check]));
}

describe('signal integrity', () => {
    test('counts inversions of a vector', () => {
        assert.equal(countInversions([]), 0);
        assert.equal(countInversions([1, 1, 2, 5]), 0);
        assert.equal(countInversions([1, 3, 2, 5, 4]), 2);
    });

    test('sorts timed events with outer events first and drops the rest', () => {
        const sorted = sortTimedEvents([
            createEvent('Inner', [15, 25]),
            createEvent('Instant', [20, 20]),
            createEvent('Outer', [10, 40]),
            createEvent('Same start, shorter', [10, 12])
        ]);

        assert.deepEqual(sorted.map(event => event.name), ['Outer', 'Same start, shorter', 'Inner']);
    });

    test('flags partial time overlaps and allocation ranges outside the time parent', () => {
        const nesting = analyzeEventNesting(sortTimedEvents([
            createEvent('Outer', [10, 40], [10, 20]),
            createEvent('Outside', [12, 17], [30, 40]),
            createEvent('Inner', [15, 25], [12, 18]),
            createEvent('Leaks', [20, 50], [15, 25]),
            createEvent('NoAllocations', [100, 110], [5, 5]),
            createEvent('Child', [101, 103], [5, 7])
        ]));

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

    test('an intact profile has no warnings', async () => {
        const { profile } = await createProfileFixture();
        const checks = checkSignalIntegrity({
            timeline: profile.timeline,
            memline: profile.memline,
            thread: null
        });

        assert.deepEqual(checks.filter(check => check.status === 'warn'), []);
        assert.ok(checksById(checks)['mapping-sample-to-allocation']);
    });

    test('skips checks of signals that are not available', async () => {
        const { profile } = await createProfileFixture();
        const cpuOnly = checkSignalIntegrity({
            timeline: profile.timeline,
            memline: null,
            thread: null
        });
        const nothing = checkSignalIntegrity({
            timeline: null,
            memline: null,
            thread: null
        });

        assert.equal(checksById(cpuOnly)['mapping-sample-to-allocation'], undefined);
        assert.ok(checksById(cpuOnly)['samples-lead']);
        assert.deepEqual(nothing, []);
    });

    test('reports non-monotone mappings', async () => {
        const { profile } = await createProfileFixture();
        const { timeline, memline } = profile;

        timeline!.mappings.memline._mapping[1] = 0;
        memline!.mappings.timeline._mapping[2] = 0;

        const checks = checksById(checkSignalIntegrity({ timeline, memline, thread: null }));

        assert.equal(checks['mapping-sample-to-allocation'].status, 'warn');
        assert.equal(checks['mapping-allocation-to-sample'].status, 'warn');
    });

    test('counts events by duration and allocation range', async () => {
        const { profile } = await createProfileFixture();
        const thread = createThread([
            createEvent('Covering', [0, 10], [0, 3]),
            createEvent('Empty', [0, 5], [2, 2]),
            createEvent('Inverted', [6, 8], [3, 1]),
            createEvent('Instant', [9, 9], [0, 1]),
            createEvent('Missing', [0, 1])
        ]);
        const checks = checksById(checkSignalIntegrity({
            timeline: profile.timeline,
            memline: null,
            thread
        }));

        assert.equal(checks['events-without-duration'].count, 1);
        assert.equal(checks['events-with-allocations'].count, 2);
        assert.equal(checks['events-allocation-range-inverted'].count, 1);
        assert.equal(checks['events-allocation-range-inverted'].status, 'warn');
    });

    test('reports events outside the sample time axis', async () => {
        const { profile } = await createProfileFixture({ startTime: 100 });
        const { timeline, memline } = profile;
        const thread = createThread([
            createEvent('Early', [timeline!.axisStart - 5, timeline!.axisStart - 3]),
            createEvent('Late', [timeline!.axisEnd + 7, timeline!.axisEnd + 8])
        ]);

        const checks = checksById(checkSignalIntegrity({ timeline, memline, thread }));
        const outside = checks['events-outside-axis'];

        assert.equal(outside.status, 'warn');
        assert.equal(outside.count, 2);
        assert.match(outside.detail, /1 before, 1 after, of 2;/);
        assert.match(outside.detail, /furthest 0\.0 ms \(0\.70 intervals\)/);
        assert.equal(checks['events-nesting'].status, 'ok');
    });

    describe('allocation stage attribute', () => {
        // fixture has 4 allocations, so event ranges are in 0..4 allocation indexes
        async function createStageCheck(stageByAllocation: number[]) {
            const { profile } = await createProfileFixture();
            const thread = createThread([
                createEvent('Outer', [0, 100], [0, 3]),
                createEvent('Inner', [10, 20], [1, 2])
            ]);

            profile.memline!.attributes.push({
                name: 'allocationCompilationStage',
                values: Uint8Array.from(stageByAllocation),
                dict: ['none', 'Outer', 'Inner']
            });

            const checks = checkSignalIntegrity({
                timeline: profile.timeline,
                memline: profile.memline,
                thread
            });

            return checksById(checks)['allocation-stage-attribute'];
        }

        test('matches the innermost event, with no event after the last range', async () => {
            const check = await createStageCheck([1, 2, 1, 0]);

            assert.equal(check.status, 'ok');
            assert.equal(check.total, 4);
        });

        test('counts allocations owned by a different stage', async () => {
            const check = await createStageCheck([1, 1, 1, 2]);

            assert.equal(check.status, 'warn');
            assert.equal(check.count, 2);
        });
    });

    test('the method is cached per profile and resolves the scope profile', async () => {
        const { profile } = await createProfileFixture();
        const context = {
            primaryProfile: profile,
            scopeProfile: null,
            data: { profiles: [profile] }
        };
        const withoutProfile = { ...context, primaryProfile: null };
        const first = query('signalIntegrity()')(null, context);

        assert.ok(Array.isArray(first) && first.length > 0);
        assert.equal(query('signalIntegrity()')(null, context), first);
        assert.equal(query('signalIntegrity()')(profile, withoutProfile), first);
        assert.deepEqual(query('signalIntegrity()')(null, withoutProfile), []);
    });
});
