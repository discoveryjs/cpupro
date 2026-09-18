import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createProfileFixture, type ProfileFixtureOptions } from '../../test/fixtures/profile.js';
import { createProfile } from './profile.mjs';

const dimensions = ['locations', 'callFrames', 'modules', 'packages', 'categories', 'owners'] as const;
const cases: { name: string; options: ProfileFixtureOptions; populations: number }[] = [
    { name: 'combined', options: {}, populations: 3 },
    { name: 'context nodes', options: { contexts: [1, 2, 1, 0] }, populations: 3 },
    { name: 'sparse CPU IDs', options: { mapping: [0, 4, 4] }, populations: 3 },
    { name: 'unused trailing CPU ID', options: { mapping: [4, 4, 4] }, populations: 3 },
    { name: 'uncovered allocations', options: { mapping: [1, 2, 2] }, populations: 3 },
    { name: 'call-frame fallback', options: { fallback: true }, populations: 3 },
    { name: 'no source maps', options: { noSourceMap: true }, populations: 3 },
    { name: 'CPU only', options: { cpuOnly: true }, populations: 1 },
    { name: 'stack only', options: { stackOnly: true }, populations: 2 },
    { name: 'locations only', options: { locationsOnly: true }, populations: 2 }
];

describe('profile breakdowns', () => {
    test('does not create a CPU population or timeline when only allocation events are available', async () => {
        let checkedCpuPopulation = false;
        const profile = await createProfile({
            startTime: 0,
            endTime: 30,
            nodes: [{ id: 1, callFrame: { scriptId: 0, url: '', functionName: '(root)', lineNumber: -1, columnNumber: -1 } }],
            samples: [],
            timeDeltas: [],
            _samplesInterval: 10,
            _cpuproAllocationMapping: [],
            _cpuproAllocationIds: [1, 2],
            _cpuproAllocationSizes: [16, 32],
            _cpuproAllocationScriptIds: [0, 0],
            _cpuproAllocationLocations: [-1, -1]
        }, {
            async work(name, callback) {
                const result = await callback();
                if (name === 'create CPU population') {
                    assert.equal(result, null);
                    checkedCpuPopulation = true;
                }
                return result;
            }
        });
        assert.equal(checkedCpuPopulation, true);
        assert.equal(profile.timeline, null);
        assert.deepEqual(profile.lines.map(line => line.type), ['memline']);
        assert.deepEqual(profile.memline!.breakdowns.map(breakdown => breakdown.kind), ['location']);
        assert.deepEqual([...profile.memline!.breakdowns[0].population.values], [16, 32]);
    });

    test('keeps sink outside breakdown metrics and preserves baseline bounds', async () => {
        const { profile } = await createProfileFixture();
        for (const line of profile.lines) {
            const populations = new Set(line.breakdowns.map(breakdown => breakdown.populationFiltered));
            for (const population of populations) {
                population.setRange(5, 20);
                population.updateMask(mask => {
                    mask[0] |= 0x80000000;
                });
                const accepted = population.samplesTotal.reduce((sum, value) => sum + value, 0);
                assert.equal(accepted + population.sink.total, 15);
                for (const breakdown of line.breakdowns.filter(entry => entry.populationFiltered === population)) {
                    for (const name of dimensions) {
                        const dimension = breakdown[name];
                        if (!dimension) {
                            continue;
                        }
                        const metrics = dimension.filtered.nodes;
                        assert.equal(metrics.selfValues[0] + metrics.nestedValues[0], accepted);
                        assert.equal(dimension.filtered.dict.selfValues.reduce((sum, value) => sum + value, 0), accepted);
                        assert.equal(dimension.bounds.samples, population.population.samples);
                        assert.equal(dimension.bounds.firstSeen[0], 0);
                        assert.equal(dimension.bounds.lastSeen[0], population.cumulative[population.cumulative.length - 1]);
                    }
                }
                population.resetMask();
                population.resetRange();
                assert.deepEqual(population.samplesTotal, population.population.samplesTotal);
            }
        }
    });

    test.each([
        { name: 'uncovered tail', mapping: [1, 2, 2], expected: [0, 1, 0, 0] },
        { name: 'short mapping', mapping: [1, 2], expected: [0, 1, 0, 0] },
        { name: 'no allocation captured by a CPU sample', mapping: [0, 0, 0], expected: [0, 0, 0, 0] },
        { name: 'missing intermediate mapping', mapping: Object.assign(new Array<number>(3), { 0: 1, 2: 4 }), expected: [0, 0, 0, 0] }
    ])('preserves allocation weights and attributes to CPU samples: $name', async ({ mapping, expected }) => {
        const { profile } = await createProfileFixture({ mapping });
        const line = profile.memline!;
        const stack = line.breakdowns.find(breakdown => breakdown.kind === 'call-stack')!;
        const locations = line.breakdowns.find(breakdown => breakdown.kind === 'location')!;
        assert.deepEqual([...stack.population.samples], expected);
        assert.equal(stack.population.values, line.values);
        assert.equal(stack.population.values, locations.population.values);
        assert.deepEqual([...stack.population.values], [16, 32, 48, 64]);
        assert.deepEqual(stack.population.cumulative, locations.population.cumulative);
        const metrics = stack.callFrames!.all.nodes;
        assert.equal(metrics.selfValues[0] + metrics.nestedValues[0], 160);
    });

    test.each(cases)('shares sources, populations and selection: $name', async ({ options, populations }) => {
        const { profile } = await createProfileFixture(options);
        const breakdowns = profile.lines.flatMap(line => line.breakdowns);
        assert.equal(new Set(breakdowns.map(breakdown => breakdown.population)).size, populations);
        assert.equal(new Set(breakdowns.map(breakdown => breakdown.populationFiltered)).size, populations);
        assert.equal(new Set(breakdowns.map(breakdown => breakdown.populationFiltered.source)).size, populations);

        for (const line of profile.lines) {
            const expectedKinds = line.type === 'timeline'
                ? ['call-stack']
                : [...options.locationsOnly ? [] : ['call-stack'], ...options.stackOnly ? [] : ['location']];
            const mappedKinds = options.noSourceMap ? [] : expectedKinds
                .filter(kind => !options.fallback || kind !== 'call-stack')
                .map(kind => `${kind}-sm`);
            assert.deepEqual(line.breakdowns.map(breakdown => breakdown.kind), [...expectedKinds, ...mappedKinds]);

            for (const breakdown of line.breakdowns) {
                assert.equal(breakdown.line, line);
                assert.equal(breakdown.populationFiltered.population, breakdown.population);
                assert.notEqual(breakdown.populationFiltered.source, breakdown.population);
                assert.equal(breakdown.populationFiltered.source, breakdown.populationViewport);
                assert.equal(breakdown.populationViewport.source, breakdown.population);
                assert.equal(breakdown.populationFiltered.source.cumulative, breakdown.population.cumulative);
                for (const sample of breakdown.population.samples) {
                    const node = breakdown.source.sourceIdToNode[sample];
                    assert.ok(node >= 0 && node < breakdown.source.nodes.length);
                }
                for (const name of dimensions) {
                    const dimension = breakdown[name];
                    if (dimension) {
                        assert.equal(dimension.bounds.tree, dimension.tree);
                        assert.equal(dimension.bounds.sampleToNode, dimension.sampleToNode);
                        assert.equal(dimension.bounds.sampleToNode, dimension.all.nodes.sampleToNode);
                        assert.equal(dimension.bounds.sampleToNode, dimension.filtered.nodes.sampleToNode);
                    }
                }
            }

            for (const kind of expectedKinds) {
                const original = line.breakdowns.find(breakdown => breakdown.kind === kind)!;
                const mapped = line.breakdowns.find(breakdown => breakdown.kind === `${kind}-sm`);
                if (!mapped) {
                    continue;
                }
                assert.equal(mapped.population, original.population);
                assert.equal(mapped.populationFiltered, original.populationFiltered);
                assert.equal(mapped.source.parent, original.source.parent);
                assert.equal(mapped.source.sourceIdToNode, original.source.sourceIdToNode);
                assert.equal(mapped.source.dictionary, original.source.dictionary);
                assert.notEqual(mapped.source.nodes, original.source.nodes);
                assert.ok(mapped.locations!.tree.dictionary.some(location => location.script?.url.endsWith('original.js')));

                let originalUpdates = 0;
                let mappedUpdates = 0;
                const unsubscribeOriginal = original.callFrames!.filtered.nodes.subscribe(() => originalUpdates++);
                const unsubscribeMapped = mapped.callFrames!.filtered.nodes.subscribe(() => mappedUpdates++);
                const allBefore = mapped.callFrames!.all.nodes.selfValues.slice();
                original.populationFiltered.setRange(5, 20);
                assert.equal(originalUpdates, 1);
                assert.equal(mappedUpdates, 1);
                assert.deepEqual(mapped.callFrames!.all.nodes.selfValues, allBefore);
                const filtered = mapped.callFrames!.filtered.nodes;
                assert.equal(filtered.selfValues[0] + filtered.nestedValues[0], 15);
                original.populationFiltered.resetRange();
                assert.equal(originalUpdates, 2);
                assert.equal(mappedUpdates, 2);
                assert.deepEqual(filtered.selfValues, mapped.callFrames!.all.nodes.selfValues);
                unsubscribeOriginal();
                unsubscribeMapped();
            }
        }

        const cpuStack = profile.timeline!.breakdowns[0];
        const allocationStack = profile.memline?.breakdowns.find(breakdown => breakdown.kind === 'call-stack');
        if (allocationStack) {
            assert.equal(cpuStack.source, allocationStack.source);
        }
    });
});
