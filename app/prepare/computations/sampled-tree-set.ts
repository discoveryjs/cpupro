import type { Dictionary } from '../dictionary.js';
import type { WorkHandler } from '../misc/work.js';
import type { CpuProCallFrame, CpuProLocation, CpuProModule, CpuProPackage, CpuProCategory, CpuProOwner } from '../types.js';
import { Usage } from '../usage.js';
import { createTreeSet, createTreeSourceFromParent, type TreeSource } from './build-trees.js';
import type { CallTree } from './call-tree.js';
import type { SampledTree } from './metrics.js';

export type CpuProCallTree =
    | CallTree<CpuProLocation>
    | CallTree<CpuProCallFrame>
    | CallTree<CpuProModule>
    | CallTree<CpuProPackage>
    | CallTree<CpuProCategory>
    | CallTree<CpuProOwner>;

export type SampledCpuProCallTree =
    | SampledTree<CpuProLocation>
    | SampledTree<CpuProCallFrame>
    | SampledTree<CpuProModule>
    | SampledTree<CpuProPackage>
    | SampledTree<CpuProCategory>
    | SampledTree<CpuProOwner>;

// A source of samples of another source: the source id of every sample in the other source
export type SampledTreeSourceOrigin = {
    source: SampledTreeSet['source'];
    sourceIds: Uint32Array;
};

export type SampledTreeSet = {
    source: (TreeSource<CpuProLocation> | TreeSource<CpuProCallFrame>) & { origin?: SampledTreeSourceOrigin };
    sampledTrees: SampledCpuProCallTree[];
    dictionary: Dictionary | Usage;
};

export async function createSampledTreeSet(
    dictionary: Dictionary,
    treeSource: SampledTreeSet['source'],
    work: WorkHandler
): Promise<SampledTreeSet> {
    // Keep this switch to compare usage-local dictionaries with the full dictionary during testing.
    const useUsage = true;
    const usage = useUsage ? await work('usage', () =>
        new Usage(dictionary, treeSource)
    ) : null;
    const treeSetDictionary = usage
        ? treeSource.dictionary === dictionary.locations
            ? usage.locations!
            : usage.callFrames
        : treeSource.dictionary;
    const treeSetNodes = usage
        ? treeSource.nodes.map(dictIndex => usage.mapToUsage[dictIndex])
        : treeSource.nodes;

    const treeSetSource = createTreeSourceFromParent<CpuProLocation | CpuProCallFrame>(
        treeSource.parent,
        treeSource.sourceIdToNode,
        treeSetNodes,
        treeSetDictionary
    ) as SampledTreeSet['source'];

    const treeSet = await work('create tree set', () =>
        createTreeSet(
            usage || dictionary,
            treeSetSource
        )
    );

    const sampledTrees = await work('map samples to trees', () =>
        createSampledTrees(
            treeSet.sourceIdToNode,
            [
                ...(treeSet.locations ? [treeSet.locations] : []),
                treeSet.callFrames,
                treeSet.modules,
                treeSet.packages,
                treeSet.categories,
                treeSet.owners
            ]
        )
    );

    return {
        sampledTrees,
        source: treeSource,
        dictionary: usage || dictionary
    };
}

export function createSampledTrees(
    sampleIdToEntryTreeNode: Int32Array,
    trees: CpuProCallTree[]
) {
    const sampledTrees: SampledCpuProCallTree[] = [];
    const sampleToNodeBySourceTree = new Map<CpuProCallTree | null, Uint32Array>(
        [[null, new Uint32Array(sampleIdToEntryTreeNode)]]
    );

    while (sampledTrees.length < trees.length) {
        let foundNewTree = false;

        for (const tree of trees) {
            if (sampleToNodeBySourceTree.has(tree)) {
                continue;
            }

            const sourceTreeSampleToNode = sampleToNodeBySourceTree.get(tree.sourceTree as CpuProCallTree | null);

            if (sourceTreeSampleToNode !== undefined) {
                const treeSampleToNode = tree.sourceIdToNode;
                const sampleToNode = sourceTreeSampleToNode.map(id => treeSampleToNode[id]);

                foundNewTree = true;
                sampleToNodeBySourceTree.set(tree, sampleToNode);
                sampledTrees.push({
                    tree,
                    sampleToNode
                } as SampledCpuProCallTree);
            }
        }

        if (!foundNewTree) {
            throw new Error('Failed to remap samples for all trees');
        }
    }

    return sampledTrees;
}

// The tree set of samples of another set's source, a source id per sample: the trees and the dictionary are shared,
// the source and the maps of samples to tree nodes take the nodes of the samples' source ids
export function sampledTreeSetOfSourceIds(treeSet: SampledTreeSet, sampleSourceIds: Uint32Array): SampledTreeSet {
    const { source, sampledTrees, dictionary } = treeSet;
    const sourceIdToNode = new Int32Array(sampleSourceIds.length);
    const samplesTrees: SampledCpuProCallTree[] = [];

    for (let i = 0; i < sampleSourceIds.length; i++) {
        sourceIdToNode[i] = source.sourceIdToNode[sampleSourceIds[i]];
    }

    for (let i = 0; i < sampledTrees.length; i++) {
        const { tree, sampleToNode } = sampledTrees[i];
        const samplesToNode = new Uint32Array(sampleSourceIds.length);

        for (let j = 0; j < sampleSourceIds.length; j++) {
            samplesToNode[j] = sampleToNode[sampleSourceIds[j]];
        }

        samplesTrees.push({
            tree,
            sampleToNode: samplesToNode
        } as SampledCpuProCallTree);
    }

    return {
        source: {
            ...source,
            sourceIdToNode,
            origin: {
                source,
                sourceIds: sampleSourceIds
            }
        },
        sampledTrees: samplesTrees,
        dictionary
    };
}
