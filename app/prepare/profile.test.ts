import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createProfileFixture, type ProfileFixtureOptions } from '../../test/fixtures/profile.js';

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
    test.each(cases)('shares sources, populations and selection: $name', async ({ options, populations }) => {
        const { profile } = await createProfileFixture(options);
        const breakdowns = profile.lines.flatMap(line => line.breakdowns);
        assert.equal(new Set(breakdowns.map(breakdown => breakdown.population)).size, populations);
        assert.equal(new Set(breakdowns.map(breakdown => breakdown.populationFiltered)).size, populations);

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
