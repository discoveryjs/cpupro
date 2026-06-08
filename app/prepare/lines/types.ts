import { LineMapping } from '../computations/line-mapping';
import { CallTree } from '../computations/call-tree';
import { DictDimension, DictionaryMetrics, SamplesMetrics, SamplesMetricsFiltered, TreeDimension, TreeMetrics, TreeValueBounds } from '../computations/metrics';
import { Profile } from '../profile.mjs';
import { CpuProCallFrame, CpuProCategory, CpuProLocation, CpuProModule, CpuProNode, CpuProPackage } from '../types';

export type ProfileLineType = 'timeline' | 'memline';
export type LineKind = 'time' | 'memory'
export type Metric =
    | 'axis'
    | 'samplingInterval'
    | 'selfValue'
    | 'nestedValue'
    | 'totalValue';

export type LineTreeMetricState<T extends CpuProNode> = {
    nodes: TreeMetrics<T>;
    dict: DictionaryMetrics<T>;
};

export type LineTreeDimension<T extends CpuProNode> = {
    tree: CallTree<T>;
    sampleToNode: Uint32Array;
    all: LineTreeMetricState<T>;
    filtered: LineTreeMetricState<T>;
    bounds: TreeValueBounds<T>;
};

export type ProfileLineTree = {
    kind: string;
    line: ProfileLine;
    locations: LineTreeDimension<CpuProLocation> | null;
    callFrames: LineTreeDimension<CpuProCallFrame> | null;
    modules: LineTreeDimension<CpuProModule> | null;
    packages: LineTreeDimension<CpuProPackage> | null;
    categories: LineTreeDimension<CpuProCategory> | null;
};

export type Axis = {
    start: number;
    startNoSamples: number;
    end: number;
    endNoSamples: number;
    total: number;
    samplesInterval: number;
}

export interface ProfileLine {
    type: ProfileLineType;
    kind: LineKind;
    profile: Profile;

    sourceInfo: {
        nodes: number;
        samples: number;
        samplesInterval: number;
    };

    formatValue(value: number, precision?: number): string;
    valueWithUnit(value: number, precision?: number): { value: string; unit: string };
    metricName(metric: Metric): string;
    metricDefinition(metric: Metric): string;

    // Axis metadata
    axisStart: number;
    axisStartNoSamples: number;
    axisEnd: number;
    axisEndNoSamples: number;
    axisTotal: number;

    // Sample domain (always present)
    samples: Uint32Array;                // line sample id per value

    // Values (generic metric)
    values: Uint32Array;
    samplesMetrics: SamplesMetrics;
    samplesMetricsFiltered: SamplesMetricsFiltered;
    recomputeMetrics: () => void;

    // Dictionary-based dimensions (aggregated by entity, no tree structure needed)
    dict: {
        locations: DictDimension<CpuProLocation> | null;
        callFrames: DictDimension<CpuProCallFrame> | null;
        modules: DictDimension<CpuProModule> | null;
        packages: DictDimension<CpuProPackage> | null;
        categories: DictDimension<CpuProCategory> | null;
    };

    // Tree-based dimensions (requires call tree structure)
    tree: {
        locations: TreeDimension<CpuProLocation> | null;
        callFrames: TreeDimension<CpuProCallFrame> | null;
        modules: TreeDimension<CpuProModule> | null;
        packages: TreeDimension<CpuProPackage> | null;
        categories: TreeDimension<CpuProCategory> | null;
    };

    // Line-owned tree views. Several lines may reuse the same tree structure,
    // while keeping independent sample-to-node mappings and metrics.
    trees: ProfileLineTree[];

    // Optional line-owned vector locations.
    // Tree-derived locations remain available through dict.locations and tree.locations.
    locations: DictDimension<CpuProLocation> & {
        sampleToLocation: Uint32Array;
    } | null;

    // Mappings to other lines (key = target line kind)
    mappings: Record<ProfileLineType, LineMapping>;
};

export type TimelineLine = ProfileLine & {
    type: 'timeline';
    kind: 'time';
};

export type ProfileMemline = ProfileLine & {
    type: 'memline';
    kind: 'memory';

    // Memory-specific metadata
    valueTypes: Uint32Array | null;
    valueTypesDict: Record<number, string> | null;
    valueGcEpochs: Uint32Array | null;
    valueGcEpochsDict: GcEpochDictEntry[] | null;
    valueLifespans: Uint8Array | null;
    valueLifespansDict: string[] | null;
    valueSpaces: Uint32Array | null;
    valueSpacesDict: string[] | null;

    // experimental fields for cross-profile stable allocations
    // _commonTree: TreeSource<CpuProCallFrame>;
    _uniqueValuesMap: Map<number, number>;
    _uniqueValuesArray: Array<number>;
    _callFramesMap: Map<CpuProCallFrame, number>;
    _callFramesVariance: Uint32Array;
    _callFramesStable: Uint32Array;
    _samplesAll: Uint32Array;
    _samplesStable: Uint32Array;
};

export type GcEpochDictEntry = {
    type: 'minor' | 'major' | 'none'; // 'none' for allocations not collected by GC
    epoch: number;
    color: string;
};
