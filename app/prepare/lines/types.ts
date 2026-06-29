import { LineMapping } from '../computations/line-mapping';
import { CallTree } from '../computations/call-tree';
import { DictionaryMetrics, SamplesMetrics, SamplesMetricsFiltered, TreeMetrics, TreeValueBounds } from '../computations/metrics';
import { Profile } from '../profile.mjs';
import { CpuProCallFrame, CpuProCategory, CpuProLocation, CpuProModule, CpuProNode, CpuProOwner, CpuProPackage } from '../types';

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

export type ProfileLineBreakdown = {
    kind: string;
    line: ProfileLine;
    samplesMetrics: SamplesMetrics;
    samplesMetricsFiltered: SamplesMetricsFiltered;
    recomputeMetrics: () => void;
    locations: LineTreeDimension<CpuProLocation> | null;
    callFrames: LineTreeDimension<CpuProCallFrame> | null;
    modules: LineTreeDimension<CpuProModule> | null;
    packages: LineTreeDimension<CpuProPackage> | null;
    categories: LineTreeDimension<CpuProCategory> | null;
    owners: LineTreeDimension<CpuProOwner> | null;
};

export type ProfileLineAllocationTypeAttribute = {
    name: 'allocationType';
    values: Uint32Array;
    dict: string[];
};
export type ProfileLineAllocationGcEpochAttribute = {
    name: 'allocationGcEpoch';
    values: Uint32Array;
    dict: GcEpochDictEntry[];
};
export type ProfileLineAllocationLifespanAttribute = {
    name: 'allocationLifespan';
    values: Uint8Array;
    dict: string[];
};
export type ProfileLineAllocationSpaceAttribute = {
    name: 'allocationSpace';
    values: Uint32Array;
    dict: string[];
};
export type ProfileLineAttribute =
    | ProfileLineAllocationTypeAttribute
    | ProfileLineAllocationGcEpochAttribute
    | ProfileLineAllocationLifespanAttribute
    | ProfileLineAllocationSpaceAttribute;

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

    // Stream of signals (e.g. time deltas, memory allocations) for this line in its primary axis
    values: Uint32Array;
    attributes: ProfileLineAttribute[];

    // Line-owned tree breakdowns. Several lines may reuse the same tree structure,
    // while keeping independent sample-to-node mappings and metrics.
    breakdowns: ProfileLineBreakdown[];

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
};

export type GcEpochDictEntry = {
    type: 'minor' | 'major' | 'none'; // 'none' for allocations not collected by GC
    epoch: number;
    color: string;
};
