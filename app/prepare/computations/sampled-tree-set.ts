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

export type SampledTreeSet = {
    source: TreeSource<CpuProLocation> | TreeSource<CpuProCallFrame>;
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
