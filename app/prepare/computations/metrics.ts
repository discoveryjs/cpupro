import { Observer, exposeGetters } from './misc.js';
import { CpuProNode } from '../types.js';
import { CallTree, AncestorSubsetCallTree } from './call-tree.js';
import { Population, PopulationFiltered } from './population.js';
import {
    computeMetrics,
    createDimensionMaps,
    type DictionaryMetricsMap,
    type DimensionMaps,
    type TreeMetricsMap
} from './metrics.compute.js';

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
    // Gives the metric arrays brought up to date
    #values: () => TreeMetricsMap<T>;

    constructor(
        tree: CallTree<T>,
        sampleToNode: Uint32Array,
        values: () => TreeMetricsMap<T>
    ) {
        super();

        this.tree = tree;
        this.sampleToNode = sampleToNode;
        this.#values = values;
        exposeGetters(this, TreeMetrics.prototype, ['samplesCount', 'selfValues', 'nestedValues']);
    }

    get samplesCount() {
        return this.#values().samplesCount;
    }

    get selfValues() {
        return this.#values().selfValues;
    }

    get nestedValues() {
        return this.#values().nestedValues;
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
        const treeMap = {
            tree,
            sampleToNode,
            samplesCount: new Uint32Array(size),
            selfValues: new Float64Array(size),
            nestedValues: new Float64Array(size)
        };

        super(tree, sampleToNode, () => treeMap);

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
        const sampleToNode = projectSampleToNode(tree, originalMetrics);
        const treeMap = {
            tree,
            sampleToNode,
            samplesCount: new Uint32Array(size),
            selfValues: new Float64Array(size),
            nestedValues: new Float64Array(size)
        };

        super(tree, sampleToNode, () => treeMap);

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
    // Gives the metric arrays brought up to date
    #values: () => DictionaryMetricsMap<T>;

    constructor(
        dictionary: T[],
        values: () => DictionaryMetricsMap<T>
    ) {
        super();

        this.dictionary = dictionary;
        this.#values = values;
        exposeGetters(this, DictionaryMetrics.prototype, ['samplesCount', 'selfValues', 'totalValues', 'entries']);
    }

    get samplesCount() {
        return this.#values().samplesCount;
    }

    get selfValues() {
        return this.#values().selfValues;
    }

    get totalValues() {
        return this.#values().totalValues;
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
        const values = this.#values;

        return {
            samples: {
                enumerable: true,
                get(this: DictionaryMetric<T>) {
                    return values().samplesCount[this.entryIndex];
                }
            },
            selfValue: {
                enumerable: true,
                get(this: DictionaryMetric<T>) {
                    return values().selfValues[this.entryIndex];
                }
            },
            nestedValue: {
                enumerable: true,
                get(this: DictionaryMetric<T>) {
                    const { selfValues, totalValues } = values();

                    return totalValues[this.entryIndex] - selfValues[this.entryIndex];
                }
            },
            totalValue: {
                enumerable: true,
                get(this: DictionaryMetric<T>) {
                    return values().totalValues[this.entryIndex];
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

function copyMetrics<T>(source: DimensionMaps<T>, target: DimensionMaps<T>) {
    target.treeMap.samplesCount.set(source.treeMap.samplesCount);
    target.treeMap.selfValues.set(source.treeMap.selfValues);
    target.treeMap.nestedValues.set(source.treeMap.nestedValues);
    target.dictMap.samplesCount.set(source.dictMap.samplesCount);
    target.dictMap.selfValues.set(source.dictMap.selfValues);
    target.dictMap.totalValues.set(source.dictMap.totalValues);
}

function createDimension<T extends CpuProNode>(
    sampledTree: SampledTree<T>,
    allValues: () => DimensionMaps<T>,
    filteredValues: () => DimensionMaps<T>
): { dict: DictDimension<T>; tree: TreeDimension<T> } {
    const { tree, sampleToNode } = sampledTree;

    return {
        dict: {
            all: new DictionaryMetrics(tree.dictionary, () => allValues().dictMap),
            filtered: new DictionaryMetrics(tree.dictionary, () => filteredValues().dictMap)
        },
        tree: {
            all: new TreeMetrics(tree, sampleToNode, () => allValues().treeMap),
            filtered: new TreeMetrics(tree, sampleToNode, () => filteredValues().treeMap)
        }
    };
}

// Metrics of a breakdown are computed, and their arrays allocated, when a dimension is first read, since views read
// the metrics of the displayed breakdown only and the other breakdowns of a line may never be read. The metrics of
// all events are of the base population, the filtered ones of the filtered population and follow its changes when
// they are read; while the population is unchanged since the breakdown was created, the two are the same, and the
// one read second copies the other. The filtered metrics have arrays of their own even then, since a view keeps the
// arrays of the metrics it shows and reads them again when notified of a change
export function createSampleBreakdown<T extends readonly SampledTree<CpuProNode>[]>(
    population: PopulationFiltered,
    trees: [...T]
) {
    const base = population.population;
    const allDimensions: (DimensionMaps<CpuProNode> | null)[] = new Array(trees.length).fill(null);
    const filteredDimensions: (DimensionMaps<CpuProNode> | null)[] = new Array(trees.length).fill(null);
    const staleDimensions = new Uint8Array(trees.length);
    let populationChanged = false;
    const allValues = (index: number) => {
        let maps = allDimensions[index];

        if (maps === null) {
            const filtered = filteredDimensions[index];

            maps = allDimensions[index] = createDimensionMaps(trees[index]);

            if (!populationChanged && filtered !== null) {
                copyMetrics(filtered, maps);
            } else {
                computeMetrics(base.samplesCount, base.samplesTotal, maps.treeMap, maps.dictMap);
            }
        }

        return maps;
    };
    const filteredValues = (index: number) => {
        let maps = filteredDimensions[index];

        if (maps === null) {
            const all = allDimensions[index];

            maps = filteredDimensions[index] = createDimensionMaps(trees[index]);

            if (!populationChanged && all !== null) {
                copyMetrics(all, maps);
                return maps;
            }
        } else if (staleDimensions[index] === 0) {
            return maps;
        }

        staleDimensions[index] = 0;
        computeMetrics(population.samplesCount, population.samplesTotal, maps.treeMap, maps.dictMap);

        return maps;
    };

    // Build dimensions with dict/tree separation
    const dimensionsWithStructure = trees.map((sampledTree, index) =>
        createDimension(sampledTree, () => allValues(index), () => filteredValues(index))
    );

    const recomputeMetrics = () => {
        populationChanged = true;
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
