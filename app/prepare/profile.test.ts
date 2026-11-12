import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createProfileFixture, type ProfileFixtureOptions } from '../../test/fixtures/profile.js';
import { findBreakdown } from '../../test/fixtures/lines.js';
import { createProfile } from './profile.mjs';
import { createWorkHandler, noopWorkHandler, type WorkIdentity } from './misc/work.js';
import { createDiagnosticsCollector } from './diagnostics.js';
import type { CpuProLocation, V8CpuProfile } from './types.js';
import type { ProfileLineBreakdown } from './lines/types.js';
import { sum } from '../../test/helpers/values.js';

const dimensions = ['locations', 'callFrames', 'modules', 'packages', 'categories', 'owners'] as const;
type NamedDimension = Exclude<typeof dimensions[number], 'locations'>;
const allKinds = {
    timeline: ['call-stack', 'call-stack-sm'],
    memline: ['call-stack', 'location', 'call-stack-sm', 'location-sm']
};
const cases: { name: string; options: ProfileFixtureOptions; populations: number }[] = [
    {
        name: 'combined',
        options: {},
        populations: 3
    },
    {
        name: 'context nodes',
        options: { contexts: [1, 2, 1, 0] },
        populations: 3
    },
    {
        name: 'sparse CPU IDs',
        options: { mapping: [0, 4, 4] },
        populations: 3
    },
    {
        name: 'unused trailing CPU ID',
        options: { mapping: [4, 4, 4] },
        populations: 3
    },
    {
        name: 'uncovered allocations',
        options: { mapping: [1, 2, 2] },
        populations: 3
    },
    {
        name: 'call-frame fallback',
        options: { fallback: true },
        populations: 3
    },
    {
        name: 'no source maps',
        options: { noSourceMap: true },
        populations: 3
    },
    {
        name: 'CPU only',
        options: { cpuOnly: true },
        populations: 1
    },
    {
        name: 'stack only',
        options: { stackOnly: true },
        populations: 2
    },
    {
        name: 'locations only',
        options: { locationsOnly: true },
        populations: 2
    }
];

function createNode(id: number, functionName: string, children?: number[]) {
    return {
        id,
        children,
        callFrame: {
            scriptId: 0,
            url: '',
            functionName,
            lineNumber: -1,
            columnNumber: -1
        }
    };
}

function isOriginalLocation(location: CpuProLocation) {
    return location.script !== null && location.script.url.endsWith('original.js');
}

function selfValue(breakdown: ProfileLineBreakdown, dimension: NamedDimension, name: string) {
    const entries = breakdown[dimension]!.all.dict.entries;

    return entries.find(entry => entry.entry.name === name)!.selfValue;
}

describe('profile breakdowns', () => {
    test('does not create a CPU population or timeline when only allocation events are available', async () => {
        let checkedCpuPopulation = false;
        const data: V8CpuProfile = {
            startTime: 0,
            endTime: 30,
            nodes: [createNode(1, '(root)')],
            samples: [],
            timeDeltas: [],
            _samplesInterval: 10,
            _cpuproAllocationMapping: [],
            _cpuproAllocationIds: [1, 2],
            _cpuproAllocationSizes: [16, 32],
            _cpuproAllocationScriptIds: [0, 0],
            _cpuproAllocationLocations: [-1, -1]
        };
        const checkCpuPopulation = async function<T>(identity: WorkIdentity, callback: () => T): Promise<T> {
            const result = callback();

            if (identity.name === 'create CPU population') {
                assert.equal(result, null);
                checkedCpuPopulation = true;
            }

            return result;
        };
        const profile = await createProfile(data, { work: createWorkHandler(checkCpuPopulation) });

        assert.equal(checkedCpuPopulation, true);
        assert.equal(profile.timeline, null);
        assert.deepEqual(profile.lines.map(line => line.type), ['memline']);
        assert.deepEqual(profile.memline!.breakdowns.map(breakdown => breakdown.kind), ['location']);
        assert.deepEqual([...profile.memline!.breakdowns[0].population.values], [16, 32]);
    });

    // a trace without the chunks of its profiler thread has samples, but no call tree nodes for them
    test('makes the memline of a capture without call tree nodes and ignores its CPU samples', async () => {
        const { diagnostics, diagnose } = createDiagnosticsCollector();
        const data: V8CpuProfile = {
            startTime: 0,
            endTime: 30,
            nodes: [],
            samples: [2, 2],
            timeDeltas: [10, 10],
            _cpuproAllocationIds: [1, 2],
            _cpuproAllocationSizes: [16, 32],
            _cpuproAllocationScriptIds: [0, 0],
            _cpuproAllocationLocations: [-1, -1]
        };
        const profile = await createProfile(data, { diagnose });

        assert.equal(profile.timeline, null);
        assert.deepEqual(profile.lines.map(line => line.type), ['memline']);
        assert.deepEqual([...profile.memline!.breakdowns[0].population.values], [16, 32]);
        assert.deepEqual(diagnostics.map(entry => [entry.message, entry.details]), [
            ['Ignored CPU samples of a profile with no call tree nodes', { samples: 2 }]
        ]);
    });

    test('binds allocation ranges to samples after fixing out-of-order time deltas', async () => {
        const data: V8CpuProfile = {
            startTime: 0,
            endTime: 40,
            nodes: [
                createNode(1, '(root)', [2, 3, 4]),
                createNode(2, 'a'),
                createNode(3, 'b'),
                createNode(4, 'c')
            ],
            samples: [2, 3, 4],
            timeDeltas: [10, 20, -5],
            _samplePositions: [0, 1, 2],
            _samplesInterval: 10,
            // sample "c" was taken before sample "b" despite their order in the input
            _cpuproAllocationMapping: [1, 4, 2],
            _cpuproAllocationIds: [1, 2, 3, 4],
            _cpuproAllocationSizes: [16, 32, 48, 64]
        };
        const profile = await createProfile(data, { work: noopWorkHandler });
        const sampleToAllocation = profile.timeline!.mappings.memline._mapping;
        const allocationToSample = profile.memline!.mappings.timeline._mapping;

        assert.deepEqual([...sampleToAllocation], [1, 2, 4]);
        assert.deepEqual([...allocationToSample], [0, 1, 2, 2]);

        // the order is fixed in the model, the input stays as is
        assert.deepEqual(data.samples, [2, 3, 4]);
        assert.deepEqual(data.timeDeltas, [10, 20, -5]);
        assert.deepEqual(data._samplePositions, [0, 1, 2]);
        assert.deepEqual(data._cpuproAllocationMapping, [1, 4, 2]);
    });

    test('keeps sink outside breakdown metrics and preserves baseline bounds', async () => {
        const { profile } = await createProfileFixture();
        const breakdowns = profile.lines.flatMap(line => line.breakdowns);

        for (let i = 0; i < breakdowns.length; i++) {
            const breakdown = breakdowns[i];
            const population = breakdown.populationFiltered;
            const sampleCount = population.samplesMask.length;
            const accepts = new Uint8Array(sampleCount).fill(1);

            accepts[0] = 0;
            population.setRange(5, 20);
            population.filter.set({
                key: 'samples',
                domain: 'sample',
                size: sampleCount,
                accepts
            });

            const accepted = sum(population.samplesTotal);
            const lastCumulative = population.cumulative[population.cumulative.length - 1];

            assert.equal(accepted + population.sink.total, 15);

            for (let j = 0; j < dimensions.length; j++) {
                const dimension = breakdown[dimensions[j]];

                if (!dimension) {
                    continue;
                }

                const metrics = dimension.filtered.nodes;

                assert.equal(metrics.selfValues[0] + metrics.nestedValues[0], accepted);
                assert.equal(sum(dimension.filtered.dict.selfValues), accepted);
                assert.equal(dimension.bounds.samples, population.population.samples);
                assert.equal(dimension.bounds.firstSeen[0], 0);
                assert.equal(dimension.bounds.lastSeen[0], lastCumulative);
            }

            population.filter.remove('samples');
            population.resetRange();
            assert.deepEqual(population.samplesTotal, population.population.samplesTotal);
        }
    });

    // CPU sample IDs 0 and 1 are of the three CPU samples, ID 2 is of allocations recorded after the last one
    test.each([
        {
            name: 'uncovered tail',
            mapping: [1, 2, 2],
            expected: [0, 1, 2, 2]
        },
        {
            name: 'short mapping',
            mapping: [1, 2],
            expected: [0, 1, 0, 0]
        },
        {
            // Allocations after the last recorded ID take the first sample without an ID, as on the timeline
            name: 'mapping shorter by two samples',
            mapping: [1],
            expected: [0, 1, 1, 1]
        },
        {
            // IDs beyond the samples are ignored: later allocations take the sample after the profile end
            name: 'mapping longer than the samples',
            mapping: [1, 2, 2, 4],
            expected: [0, 1, 2, 2]
        },
        {
            name: 'no allocation captured by a CPU sample',
            mapping: [0, 0, 0],
            expected: [2, 2, 2, 2]
        },
        {
            name: 'missing intermediate mapping',
            mapping: Object.assign(new Array<number>(3), { 0: 1, 2: 4 }),
            expected: [0, 0, 0, 0]
        }
    ])('preserves allocation weights and attributes to CPU samples: $name', async row => {
        const { profile } = await createProfileFixture({ mapping: row.mapping });
        const line = profile.memline!;
        const stack = findBreakdown(line, 'call-stack');
        const locations = findBreakdown(line, 'location');
        const metrics = stack.callFrames!.all.nodes;
        const cpuSamples = profile.timeline!.breakdowns[0].population.samples;
        const allocationSamples = line.mappings.timeline._mapping;
        const cpuSampleOf = (sample: number) => cpuSamples[sample];

        assert.deepEqual([...stack.population.samples], row.expected);
        assert.deepEqual([...stack.population.samples], Array.from(allocationSamples, cpuSampleOf));
        assert.equal(stack.population.values, line.values);
        assert.equal(stack.population.values, locations.population.values);
        assert.deepEqual([...stack.population.values], [16, 32, 48, 64]);
        assert.equal(stack.population.cumulative, locations.population.cumulative);
        assert.equal(metrics.selfValues[0] + metrics.nestedValues[0], 160);
    });

    test('allocations after the last CPU sample belong to an unknown call frame', async () => {
        // The last CPU sample records allocation 2, allocations 3 and 4 (48 and 64 bytes) follow it
        const { profile } = await createProfileFixture({ mapping: [1, 2, 2] });
        const stack = findBreakdown(profile.memline!, 'call-stack');
        const timeline = profile.timeline!.breakdowns[0];

        assert.equal(selfValue(stack, 'callFrames', '(after profile end)'), 112);
        assert.equal(selfValue(stack, 'modules', '(after profile end)'), 112);
        assert.equal(selfValue(stack, 'packages', '(unknown)'), 112);
        assert.equal(selfValue(stack, 'categories', 'unknown'), 112);
        assert.deepEqual([...timeline.population.values], [10, 10, 10, 0]);
        assert.equal(selfValue(timeline, 'callFrames', '(after profile end)'), 0);
        assert.deepEqual([...profile.memline!.mappings.timeline._mapping], [0, 1, 3, 3]);
        assert.deepEqual([...profile.timeline!.mappings.memline._mapping], [1, 2, 2]);
    });

    test.each([
        {
            name: 'combined',
            options: {},
            kinds: allKinds
        },
        {
            name: 'call-frame fallback',
            options: { fallback: true },
            kinds: {
                timeline: ['call-stack'],
                memline: ['call-stack', 'location', 'location-sm']
            }
        },
        {
            name: 'no source maps',
            options: { noSourceMap: true },
            kinds: {
                timeline: ['call-stack'],
                memline: ['call-stack', 'location']
            }
        },
        {
            name: 'CPU only',
            options: { cpuOnly: true },
            kinds: { timeline: allKinds.timeline }
        },
        {
            name: 'stack only',
            options: { stackOnly: true },
            kinds: {
                timeline: allKinds.timeline,
                memline: ['call-stack', 'call-stack-sm']
            }
        },
        {
            name: 'locations only',
            options: { locationsOnly: true },
            kinds: {
                timeline: allKinds.timeline,
                memline: ['location', 'location-sm']
            }
        }
    ])('creates breakdowns of the available attributions: $name', async row => {
        const { profile } = await createProfileFixture(row.options);
        const kinds: Record<string, string[]> = {};

        for (let i = 0; i < profile.lines.length; i++) {
            const line = profile.lines[i];

            kinds[line.type] = line.breakdowns.map(breakdown => breakdown.kind);
        }

        assert.deepEqual(kinds, row.kinds);
    });

    test.each(cases)('breakdowns share their population chain and map every sample to a node: $name', async row => {
        const { profile } = await createProfileFixture(row.options);
        const breakdowns = profile.lines.flatMap(line => line.breakdowns);

        assert.equal(new Set(breakdowns.map(breakdown => breakdown.population)).size, row.populations);
        assert.equal(new Set(breakdowns.map(breakdown => breakdown.populationFiltered)).size, row.populations);

        for (let i = 0; i < profile.lines.length; i++) {
            const line = profile.lines[i];

            for (let j = 0; j < line.breakdowns.length; j++) {
                const breakdown = line.breakdowns[j];
                const { population, populationViewport, populationFiltered, source } = breakdown;

                assert.equal(breakdown.line, line);
                assert.equal(populationViewport.source, population);
                assert.equal(populationFiltered.source, populationViewport);

                for (let k = 0; k < population.samples.length; k++) {
                    const node = source.sourceIdToNode[population.samples[k]];

                    assert.ok(node >= 0);
                    assert.ok(node < source.nodes.length);
                }

                for (let k = 0; k < dimensions.length; k++) {
                    const dimension = breakdown[dimensions[k]];

                    if (!dimension) {
                        continue;
                    }

                    assert.equal(dimension.bounds.tree, dimension.tree);
                    assert.equal(dimension.bounds.sampleToNode, dimension.sampleToNode);
                    assert.equal(dimension.all.nodes.sampleToNode, dimension.sampleToNode);
                    assert.equal(dimension.filtered.nodes.sampleToNode, dimension.sampleToNode);
                }
            }
        }
    });

    test.each(cases)('source-mapped breakdowns share the original population, recompute with it: $name', async row => {
        const { profile } = await createProfileFixture(row.options);

        for (let i = 0; i < profile.lines.length; i++) {
            const breakdowns = profile.lines[i].breakdowns;

            for (let j = 0; j < breakdowns.length; j++) {
                const mapped = breakdowns[j];

                if (!mapped.kind.endsWith('-sm')) {
                    continue;
                }

                const original = breakdowns.find(breakdown => breakdown.kind + '-sm' === mapped.kind)!;
                const all = mapped.callFrames!.all.nodes;
                const filtered = mapped.callFrames!.filtered.nodes;
                const allBefore = all.selfValues.slice();
                let originalUpdates = 0;
                let mappedUpdates = 0;

                assert.equal(mapped.population, original.population);
                assert.equal(mapped.populationFiltered, original.populationFiltered);
                assert.equal(mapped.source.parent, original.source.parent);
                assert.equal(mapped.source.sourceIdToNode, original.source.sourceIdToNode);
                assert.equal(mapped.source.dictionary, original.source.dictionary);
                assert.notEqual(mapped.source.nodes, original.source.nodes);
                assert.ok(mapped.locations!.tree.dictionary.some(isOriginalLocation));

                original.callFrames!.filtered.nodes.subscribe(() => originalUpdates++);
                filtered.subscribe(() => mappedUpdates++);

                original.populationFiltered.setRange(5, 20);
                assert.equal(originalUpdates, 1);
                assert.equal(mappedUpdates, 1);
                assert.deepEqual(all.selfValues, allBefore);
                assert.equal(filtered.selfValues[0] + filtered.nestedValues[0], 20 - 5);

                original.populationFiltered.resetRange();
                assert.equal(originalUpdates, 2);
                assert.equal(mappedUpdates, 2);
                assert.deepEqual(filtered.selfValues, all.selfValues);
            }
        }
    });

    test('CPU and allocation call stacks share one attribution source', async () => {
        const { profile } = await createProfileFixture();
        const allocationStack = findBreakdown(profile.memline!, 'call-stack');

        assert.equal(profile.timeline!.breakdowns[0].source, allocationStack.source);
    });
});
