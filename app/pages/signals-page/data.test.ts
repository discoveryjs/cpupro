import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import jora from 'jora';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { methods } from '../../jora/index.mjs';
import { signalWindows, signalMeasurements, compilationPopulation, signalScopes } from '../../signals.js';
import { correlations } from './correlations.js';

type Window = { start: number; end: number } | null;
type Measurement = { title: string; value: number | null; of?: number };
type Data = {
    signals: Array<{ title: string; count?: number; time: Window; ids: Window }>;
    measurements: Measurement[];
};

const query = jora.setup({ methods });
const read = (profile: unknown) => ({
    signals: query(signalWindows)(profile, {}),
    measurements: signalMeasurements
        .filter(item => query(item.when)(profile, {}))
        .map(item => ({ title: item.title, ...query(item.data)(profile, {}) }))
}) as Data;
const measure = (profile: unknown, title: string) => {
    const found = read(profile).measurements.find(item => item.title.startsWith(title));

    assert.ok(found, title);

    return { value: found.value, of: found.of };
};

describe('signals data', () => {
    test('native matrix columns retain category indices when empty categories are omitted', () => {
        const categories = [
            { category: { name: 'root' }, total: 0 },
            { category: { name: 'script' }, total: 3 },
            { category: { name: 'gc' }, total: 2 }
        ];
        const matrix = correlations('timeline').content.content.content[1].content!
            .at(-1)!.content.content;
        const cols = query(matrix.cols.slice(1))([], { categories });
        const event = { count: 4, counts: [0, 2, 2] };

        assert.deepEqual(cols.map(column => column.header), ['Event / stage', 'Samples', 'script', 'gc']);
        assert.equal(query(cols[2].content.value.slice(1))(event), 2);
        for (const denominator of ['event', 'category']) {
            assert.equal(query(cols[2].content.total.slice(1))(event, { categories, denominator }),
                denominator === 'event' ? 4 : 3);
        }
    });

    test('scopes include event-only threads without borrowing a sampled profile', () => {
        const profile = { timeline: {}, thread: { tid: 1 } };
        const eventThread = { tid: 2, profiles: [], compilations: [{ name: 'Compile' }] };
        const data = {
            profiles: [profile],
            defaultSession: { processes: [{ threads: [
                { profiles: [profile], compilations: [{ name: 'Compile' }] }, eventThread
            ] }] }
        };

        assert.deepEqual(query(signalScopes)(data), [profile, { thread: eventThread }]);
        assert.deepEqual(query(signalScopes)({}), [{}]);
    });

    test('events have independent counts, durations and windows without sample populations', () => {
        const profile = { thread: { compilations: [
            { name: 'Compile', tm: 10, duration: 20 },
            { name: 'Compile', tm: 20, duration: 0 },
            { name: 'Compile', tm: 30, duration: null }
        ] } };

        assert.deepEqual(query(compilationPopulation)(profile), [{
            name: 'Compile', count: 3, timed: 1, instant: 1, unfinished: 1,
            duration: 20, maxDuration: 20, first: 10, last: 30
        }]);
        assert.deepEqual(query(compilationPopulation)({}), []);
    });

    test('a fixture profile has CPU samples and allocations with their windows', async () => {
        const { profile } = await createProfileFixture();
        const [cpu, allocations] = read(profile).signals;

        assert.equal(cpu.count, 3);
        assert.ok(cpu.time && cpu.time.end > cpu.time.start);
        assert.deepEqual(cpu.ids, { start: 1, end: 4 });
        assert.equal(allocations.count, 4);
        assert.deepEqual(allocations.ids, { start: 0, end: 4 });
        assert.equal(allocations.time, null);
    });

    test('a CPU-only profile has no allocation rows', async () => {
        const { profile } = await createProfileFixture({ cpuOnly: true });
        const { signals, measurements } = read(profile);

        assert.equal(signals[0].ids, null);
        assert.equal(signals[1].count, undefined);
        assert.equal(signals[1].ids, null);
        assert.ok(measurements.length > 0);
        assert.equal(measurements.some(item => /mapping|Allocations/.test(item.title)), false);
    });

    test('a profile without signals has no rows', () => {
        assert.deepEqual(read({}).measurements, []);
    });

    test('events window uses events with a start on the time axis and with a range on ids', () => {
        const thread = {
            compilations: [
                { tm: 10, duration: 5, allocationStart: 2, allocationEnd: 4 },
                { tm: 20, duration: 0, allocationStart: 4, allocationEnd: 4 },
                { tm: null, duration: null, allocationStart: 1, allocationEnd: 9 },
                { tm: 30, duration: 10, allocationStart: null, allocationEnd: null }
            ]
        };
        const events = read({ thread }).signals[2];

        // the event without a start is outside of the time window, but has a place among ids
        assert.equal(events.count, 4);
        assert.deepEqual(events.time, { start: 10, end: 40 });
        assert.deepEqual(events.ids, { start: 1, end: 9 });
    });

    test('the events window ignores a range with only one end', () => {
        const thread = { compilations: [{ allocationStart: null, allocationEnd: 5 }] };

        assert.equal(read({ thread }).signals[2].ids, null);
    });

    describe('measurements', () => {
        test('count inversions of the mappings', async () => {
            const { profile } = await createProfileFixture();

            assert.equal(measure(profile, 'Inversions of the mapping sample').value, 0);

            profile.timeline!.mappings.memline._mapping[1] = 0;
            profile.memline!.mappings.timeline._mapping[2] = 0;

            assert.equal(measure(profile, 'Inversions of the mapping sample').value, 1);
            assert.equal(measure(profile, 'Inversions of the mapping allocation').value, 1);
        });

        describe('allocations outside of the sample window', () => {
            // the fixture has 4 allocations
            async function measureBoundaries(mapping: number[]) {
                const { profile } = await createProfileFixture({ mapping });

                return [
                    measure(profile, 'Allocations before the first sample'),
                    measure(profile, 'Allocations after the last sample')
                ];
            }

            test('are counted before the first and after the last sample', async () => {
                assert.deepEqual(await measureBoundaries([1, 2, 3]), [
                    { value: 1, of: 4 },
                    { value: 1, of: 4 }
                ]);
            });

            test('are none when the samples cover the whole stream', async () => {
                const [before, after] = await measureBoundaries([0, 2, 4]);

                assert.equal(before.value, 0);
                assert.equal(after.value, 0);
            });

            test('are unknown when the last mapped id exceeds the allocations', async () => {
                const [before, after] = await measureBoundaries([1, 3, 9]);

                assert.equal(before.value, null);
                assert.equal(after.value, null);
            });

            test('are unknown for a non-monotone mapping', async () => {
                const [before, after] = await measureBoundaries([1, 0, 4]);

                assert.equal(before.value, null);
                assert.equal(after.value, null);
            });
        });

        test('count sample deltas longer than 2.5 intervals', async () => {
            const { profile } = await createProfileFixture();
            const { samplesInterval } = profile.timeline!.sourceInfo;
            const values = profile.timeline!.values;

            values[1] = samplesInterval * 3;

            assert.deepEqual(measure(profile, 'Sample deltas longer'), { value: 1, of: 3 });
            assert.equal(measure(profile, 'Time in sample deltas longer').value, samplesInterval * 3);
        });

        test('count events by duration and allocation range', () => {
            const thread = {
                compilations: [
                    { tm: 0, duration: 10, allocationStart: 0, allocationEnd: 3 },
                    { tm: 0, duration: 5, allocationStart: 2, allocationEnd: 2 },
                    { tm: 6, duration: 2, allocationStart: 3, allocationEnd: 1 },
                    { tm: 9, duration: 0, allocationStart: 0, allocationEnd: 1 },
                    { tm: 0, duration: 1, allocationStart: null, allocationEnd: null },
                    { tm: null, duration: null, allocationStart: null, allocationEnd: 5 }
                ]
            };

            assert.deepEqual(measure({ thread }, 'Events without duration'), { value: 2, of: 6 });
            assert.deepEqual(measure({ thread }, 'Events covering'), { value: 2, of: 6 });
            assert.deepEqual(measure({ thread }, 'Events with an inverted'), { value: 1, of: 6 });
        });

        test('count events outside the sample time axis and the furthest distance', async () => {
            const { profile } = await createProfileFixture({ startTime: 100 });
            const { timeline } = profile;

            profile.thread = {
                compilations: [
                    { tm: timeline!.axisStart - 5, duration: 2 },
                    { tm: timeline!.axisEnd + 7, duration: 1 },
                    { tm: timeline!.axisStart, duration: 1 },
                    { tm: null, duration: null }
                ]
            } as unknown as typeof profile.thread;

            assert.deepEqual(measure(profile, 'Events starting before'), { value: 1, of: 4 });
            assert.deepEqual(measure(profile, 'Events starting after'), { value: 1, of: 4 });
            assert.equal(measure(profile, 'The furthest event start').value, 7);
        });

        test('read nesting of events', () => {
            const thread = {
                compilations: [
                    { name: 'Outer', tm: 10, duration: 30, allocationStart: 10, allocationEnd: 20 },
                    { name: 'Leaks', tm: 20, duration: 30, allocationStart: 15, allocationEnd: 25 }
                ]
            };

            assert.deepEqual(measure({ thread }, 'Events partially'), { value: 1, of: 2 });
            assert.deepEqual(measure({ thread }, 'Allocation range outside'), { value: 1, of: 1 });
        });
    });
});
