import { LineMapping } from '../computations/line-mapping';
import { DictDimension, SamplesMetrics, SamplesMetricsFiltered, TreeDimension } from '../computations/metrics';
import { Profile } from '../profile.mjs';
import { CpuProCallFrame, CpuProCategory, CpuProLocation, CpuProModule, CpuProPackage } from '../types';

export type ProfileLineType = 'timeline' | 'memline';
export type LineKind = 'time' | 'memory'
export type Metric =
    | 'axis'
    | 'samplingInterval'
    | 'selfValue'
    | 'nestedValue'
    | 'totalValue';

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
    samples: Uint32Array;                // sampleId -> profile.<tree>.sampleIdToNode[sampleId]
    sampleCounts: Uint32Array;
    sampleCountsByProfile: Uint32Array;
    sampleLocations: Int32Array | null;  // per-sample offsets in the line's primary sample domain

    // Values (generic metric)
    values: Uint32Array;
    valuesByProfile: Uint32Array;
    samplesMetrics: SamplesMetrics;
    samplesMetricsFiltered: SamplesMetricsFiltered;
    recomputeValues: () => void;

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

    // Optional line-owned vector locations.
    // Tree-derived locations remain available through dict.locations and tree.locations.
    locations: DictDimension<CpuProLocation> | null;

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
    _callFramesMap: Map<number, number>;
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
