import { Observer, exposeGetters } from './misc.js';
import { CpuProNode } from '../types.js';
import { CallTree, AncestorSubsetCallTree } from './call-tree.js';
import { Population, PopulationFiltered } from './population.js';
import { computeMetrics, createSampleBreakdownMaps, type DimensionMaps } from './metrics.compute.js';

export type DictDimension<T extends CpuProNode> = {
    all: DictionaryMetrics<T>;
    filtered: DictionaryMetrics<T>;
}

export type TreeDimension<T extends CpuProNode> = {
    all: TreeMetrics<T>;
    filtered: TreeMetrics<T>;
}

export type SampledTree<T> = {
    tree: CallTree<T>;
    sampleToNode: Uint32Array;
};

export class TreeMetrics<T extends CpuProNode> extends Observer {
    tree: CallTree<T>;
    sampleToNode: Uint32Array;
    #samplesCount: Uint32Array;
    #selfValues: Float64Array;
    #nestedValues: Float64Array;
    // Brings stale values up to date before they are read
    #refresh: (() => void) | null;

    constructor(
        tree: CallTree<T>,
        sampleToNode: Uint32Array,
        samplesCount: Uint32Array,
        selfValues: Float64Array,
        nestedValues: Float64Array,
        refresh: (() => void) | null = null
    ) {
        super();

        this.tree = tree;
        this.sampleToNode = sampleToNode;
        this.#samplesCount = samplesCount;
        this.#selfValues = selfValues;
        this.#nestedValues = nestedValues;
        this.#refresh = refresh;
        exposeGetters(this, TreeMetrics.prototype, ['samplesCount', 'selfValues', 'nestedValues']);
    }

    get samplesCount() {
        this.#refresh?.();
        return this.#samplesCount;
    }

    get selfValues() {
        this.#refresh?.();
        return this.#selfValues;
    }

    get nestedValues() {
        this.#refresh?.();
        return this.#nestedValues;
    }

    getMetrics(index: number) {
        const samples = this.samplesCount[index];
        const selfValue = this.selfValues[index];
        const nestedValue = this.nestedValues[index];

        return {
            node: this.tree.getEntry(index),
            samples,
            selfValue,
            nestedValue,
            totalValue: selfValue + nestedValue
        };
    }

    getValueMetrics(valueIndex: number) {
        const { tree, samplesCount, selfValues, nestedValues } = this;
        const { nested } = tree;
        let samples = 0;
        let selfValue = 0;
        let nestedValue = 0;

        for (const index of tree.selectNodes(valueIndex, true)) {
            samples += samplesCount[index];
            selfValue += selfValues[index];
            if (nested[index] === 0) {
                nestedValue += nestedValues[index];
            }
        }

        return {
            value: tree.dictionary[valueIndex],
            samples,
            selfValue,
            nestedValue,
            totalValue: selfValue + nestedValue
        };
    }
}

function projectSampleToNode<T extends CpuProNode>(tree: CallTree<T>, sourceMetrics: TreeMetrics<T>) {
    if (tree === sourceMetrics.tree) {
        return sourceMetrics.sampleToNode;
    }

    if (tree.sourceTree !== sourceMetrics.tree) {
        throw new Error('Unable to project samples: tree source does not match source metrics tree');
    }

    const sampleToNode = new Uint32Array(sourceMetrics.sampleToNode.length);
    const excludedNode = tree.nodes.length;

    for (let i = 0; i < sampleToNode.length; i++) {
        const nodeIndex = tree.sourceIdToNode[sourceMetrics.sampleToNode[i]];

        sampleToNode[i] = nodeIndex >= 0 ? nodeIndex : excludedNode;
    }

    return sampleToNode;
}

// The SubsetTreeMetrics class is mostly the same as TreeMetrics, but works with subtrees.
// It uses sampleToNode to land samples to existing nodes and the rest
// to a special (last) element in samplesCount/selfValues/nestedValues arrays.
export class SubsetTreeMetrics<T extends CpuProNode> extends TreeMetrics<T> {
    population: Population | PopulationFiltered;

    constructor(tree: CallTree<T>, population: Population | PopulationFiltered, sourceMetrics: TreeMetrics<T>) {
        const size = tree.nodes.length + 1; // add extra element for excluded metrics
        const sampleToNode = projectSampleToNode(tree, sourceMetrics);

        super(
            tree,
            sampleToNode,
            new Uint32Array(size),
            new Float64Array(size),
            new Float64Array(size)
        );

        this.population = population;
        this.subscribe = this.population.subscribe.bind(this.population);
        this.recompute();
    }

    get excludedMetrics() {
        const { samplesCount, selfValues, nestedValues } = this;
        const lastIndex = samplesCount.length - 1;

        return {
            samples: samplesCount[lastIndex],
            selfValue: selfValues[lastIndex],
            nestedValue: nestedValues[lastIndex],
            totalValue: selfValues[lastIndex] + nestedValues[lastIndex]
        };
    }

    recompute() {
        const treeMap = {
            tree: this.tree,
            sampleToNode: this.sampleToNode,
            samplesCount: this.samplesCount,
            selfValues: this.selfValues,
            nestedValues: this.nestedValues
        };

        computeMetrics(this.population.samplesCount, this.population.samplesTotal, treeMap, null);
    }
}

// AncestorSubsetTreeMetrics computes metrics for an AncestorSubsetCallTree by
// reading values from the original tree's filtered metrics. Each node in the
// ancestor tree maps to one or more original tree nodes (via nodeOriginals).
// Values are summed across all originals, giving each ancestor the total time
// that flows through it toward the focused call frame.
export class AncestorSubsetTreeMetrics<T extends CpuProNode> extends TreeMetrics<T> {
    originalMetrics: TreeMetrics<T>;

    constructor(tree: AncestorSubsetCallTree<T>, originalMetrics: TreeMetrics<T>) {
        const size = tree.nodes.length + 1; // +1 for excluded slot (compatibility)

        super(
            tree,
            projectSampleToNode(tree, originalMetrics),
            new Uint32Array(size),
            new Float64Array(size),
            new Float64Array(size)
        );

        this.originalMetrics = originalMetrics;
        this.subscribe = originalMetrics.subscribe.bind(originalMetrics);
        this.recompute();
    }

    recompute() {
        const { selfValues, nestedValues, samplesCount } = this;
        const origSelf = this.originalMetrics.selfValues;
        const origNested = this.originalMetrics.nestedValues;
        const origSamples = this.originalMetrics.samplesCount;
        const ancestorTree = this.tree as AncestorSubsetCallTree<T>;
        const { nodeOriginals, nodeOriginalsOffset, nodeOriginalsCount } = ancestorTree;
        const origNestedFlag = this.originalMetrics.tree.nested;

        selfValues.fill(0);
        nestedValues.fill(0);
        samplesCount.fill(0);

        for (let i = 0; i < nodeOriginalsCount.length; i++) {
            const start = nodeOriginalsOffset[i];
            const end = start + nodeOriginalsCount[i];
            for (let j = start; j < end; j++) {
                const origIdx = nodeOriginals[j];
                selfValues[i] += origSelf[origIdx];
                samplesCount[i] += origSamples[origIdx];
                // For nodes that are occurrences of the focused value (mapped to root),
                // skip nestedValues for recursive occurrences to avoid double-counting
                // (same logic as getValueMetrics)
                if (origNestedFlag[origIdx] === 0) {
                    nestedValues[i] += origNested[origIdx];
                }
            }
        }
    }
}

export type DictionaryMetric<T> = {
    entryIndex: number;
    entry: T;
    samples: number;
    selfValue: number;
    nestedValue: number;
    totalValue: number;
};

export class DictionaryMetrics<T extends CpuProNode> extends Observer {
    dictionary: T[];
    #entries: DictionaryMetric<T>[] | null = null;
    #entriesMap: WeakRef<Map<T, DictionaryMetric<T>>>;
    #samplesCount: Uint32Array;
    #selfValues: Float64Array;
    #totalValues: Float64Array;
    // Brings stale values up to date before they are read
    #refresh: (() => void) | null;

    constructor(
        dictionary: T[],
        samplesCount: Uint32Array,
        selfValues: Float64Array,
        totalValues: Float64Array,
        refresh: (() => void) | null = null
    ) {
        super();

        this.dictionary = dictionary;
        this.#samplesCount = samplesCount;
        this.#selfValues = selfValues;
        this.#totalValues = totalValues;
        this.#refresh = refresh;
        exposeGetters(this, DictionaryMetrics.prototype, ['samplesCount', 'selfValues', 'totalValues', 'entries']);
    }

    get samplesCount() {
        this.#refresh?.();
        return this.#samplesCount;
    }

    get selfValues() {
        this.#refresh?.();
        return this.#selfValues;
    }

    get totalValues() {
        this.#refresh?.();
        return this.#totalValues;
    }

    // Entries are created on the first read, since views read the entries of a few dictionaries. Their fields
    // read the dictionary's values, so an entry kept by a consumer is current after a change; the fields are own
    // accessors since Jora reads own properties
    get entries() {
        if (this.#entries === null) {
            const { dictionary } = this;
            const fields = this.#entryFields();
            const entries: DictionaryMetric<T>[] = new Array(dictionary.length);

            for (let i = 0; i < dictionary.length; i++) {
                entries[i] = Object.defineProperties({
                    entryIndex: i,
                    entry: dictionary[i]
                }, fields) as DictionaryMetric<T>;
            }

            this.#entries = entries;
        }

        return this.#entries;
    }

    #entryFields(): PropertyDescriptorMap {
        const refresh = this.#refresh;
        const samplesCount = this.#samplesCount;
        const selfValues = this.#selfValues;
        const totalValues = this.#totalValues;

        return {
            samples: {
                enumerable: true,
                get(this: DictionaryMetric<T>) {
                    refresh?.();
                    return samplesCount[this.entryIndex];
                }
            },
            selfValue: {
                enumerable: true,
                get(this: DictionaryMetric<T>) {
                    refresh?.();
                    return selfValues[this.entryIndex];
                }
            },
            nestedValue: {
                enumerable: true,
                get(this: DictionaryMetric<T>) {
                    refresh?.();
                    return totalValues[this.entryIndex] - selfValues[this.entryIndex];
                }
            },
            totalValue: {
                enumerable: true,
                get(this: DictionaryMetric<T>) {
                    refresh?.();
                    return totalValues[this.entryIndex];
                }
            }
        };
    }

    get entriesMap() {
        let map = this.#entriesMap?.deref();

        if (map === undefined) {
            this.#entriesMap = new WeakRef(map = this.entries.reduce(
                (map, element) => map.set(element.entry, element),
                new Map()
            ));
        }

        return map;
    }
    getEntry(sourceEntry: T): DictionaryMetric<T> | null {
        return this.entriesMap.get(sourceEntry) || null;
    }
}

function createDimension<T extends CpuProNode>(
    dimensionMaps: DimensionMaps<T>,
    refresh: () => void
): { dict: DictDimension<T>; tree: TreeDimension<T> } {
    const { treeMap, dictMap } = dimensionMaps;
    const dictAll = new DictionaryMetrics<T>(
        dictMap.dictionary,
        dictMap.samplesCount.slice(),
        dictMap.selfValues.slice(),
        dictMap.totalValues.slice()
    );
    const dictFiltered = new DictionaryMetrics(
        dictMap.dictionary,
        dictMap.samplesCount,
        dictMap.selfValues,
        dictMap.totalValues,
        refresh
    );
    const treeAll = new TreeMetrics(
        treeMap.tree,
        treeMap.sampleToNode,
        treeMap.samplesCount.slice(),
        treeMap.selfValues.slice(),
        treeMap.nestedValues.slice()
    );
    const treeFiltered = new TreeMetrics(
        treeMap.tree,
        treeMap.sampleToNode,
        treeMap.samplesCount,
        treeMap.selfValues,
        treeMap.nestedValues,
        refresh
    );

    return {
        dict: {
            all: dictAll,
            filtered: dictFiltered
        },
        tree: {
            all: treeAll,
            filtered: treeFiltered
        }
    };
}

export function createSampleBreakdown<T extends readonly SampledTree<CpuProNode>[]>(
    population: PopulationFiltered,
    trees: [...T]
) {
    const dimensions = createSampleBreakdownMaps(trees);

    for (let i = 0; i < dimensions.length; i++) {
        computeMetrics(population.samplesCount, population.samplesTotal, dimensions[i].treeMap, dimensions[i].dictMap);
    }

    // Filtered metrics follow population changes when they are read: a line computes its breakdowns over
    // shared populations, while views read the metrics of the displayed breakdown only
    const staleDimensions = new Uint8Array(dimensions.length);
    const refreshDimension = (index: number) => {
        if (staleDimensions[index] === 0) {
            return;
        }

        staleDimensions[index] = 0;

        const { treeMap, dictMap } = dimensions[index];

        computeMetrics(population.samplesCount, population.samplesTotal, treeMap, dictMap);
    };

    // Build dimensions with dict/tree separation
    const dimensionsWithStructure = dimensions.map((maps, index) =>
        createDimension(maps, () => refreshDimension(index))
    );

    const recomputeMetrics = () => {
        staleDimensions.fill(1);

        for (let i = 0; i < dimensionsWithStructure.length; i++) {
            dimensionsWithStructure[i].tree.filtered.notify();
            dimensionsWithStructure[i].dict.filtered.notify();
        }
    };

    // Recompute metrics on samples filter change
    population.subscribe(recomputeMetrics);

    return {
        recomputeMetrics,
        dimensions: dimensionsWithStructure
    };
}
