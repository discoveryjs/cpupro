import { CallTree } from '../computations/call-tree';
import type { FilterSet } from '../computations/filter-set.js';
import type { RangeView } from '../computations/range.js';
import type { EventSignatures } from './event-signatures.js';
import type { TreeSource } from '../computations/build-trees';
import { DictionaryMetrics, TreeMetrics } from '../computations/metrics';
import { TreeValueBounds } from '../computations/tree-node-bounds';
import { Population, PopulationFiltered } from '../computations/population';
import { Profile } from '../profile.mjs';
import { CpuProCallFrame, CpuProCategory, CpuProLocation, CpuProModule, CpuProNode, CpuProOwner, CpuProPackage } from '../types';

export type ProfileLineType = 'timeline' | 'memline';
export type LineKind = 'time' | 'memory'
export type Metric =
    | 'axis'
    | 'samplingInterval'
    | 'selfValue'
    | 'nestedValue'
    | 'totalValue'
    | 'interval';

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
    source: TreeSource<CpuProLocation> | TreeSource<CpuProCallFrame>;
    population: Population;
    populationViewport: PopulationFiltered;
    // Histogram data: the filters of populationViewport over the line's window
    populationWindow: PopulationFiltered;
    populationFiltered: PopulationFiltered;
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
    values: Uint8Array | Uint32Array;
    dict: string[];
};
export type ProfileLineAllocationGcEpochAttribute = {
    name: 'allocationGcEpoch';
    values: Uint8Array | Uint32Array;
    dict: GcEpochDictEntry[];
};
export type ProfileLineAllocationLifespanAttribute = {
    name: 'allocationLifespan';
    values: Uint8Array;
    dict: string[];
};
export type ProfileLineAllocationSpaceAttribute = {
    name: 'allocationSpace';
    values: Uint8Array | Uint32Array;
    dict: AllocationSpaceDictEntry[];
};
export type ProfileLineAllocationCodeTypeAttribute = {
    name: 'allocationCodeType';
    values: Uint8Array;
    dict: string[];
};
export type CompilationOwner = {
    scriptId: number | null;
    start: number | null;
};
export type ProfileLineAllocationOwnerAttribute = {
    name: 'allocationOwner';
    values: Uint32Array;
    dict: (CompilationOwner | null)[];
};
export type ProfileLineAllocationCompilationStageAttribute = {
    name: 'allocationCompilationStage';
    values: Uint8Array | Uint32Array;
    dict: string[];
};
export type ProfileLineAttribute =
    | ProfileLineAllocationTypeAttribute
    | ProfileLineAllocationGcEpochAttribute
    | ProfileLineAllocationLifespanAttribute
    | ProfileLineAllocationSpaceAttribute
    | ProfileLineAllocationCodeTypeAttribute
    | ProfileLineAllocationOwnerAttribute
    | ProfileLineAllocationCompilationStageAttribute;

export type Axis = {
    start: number;
    startNoSamples: number;
    end: number;
    endNoSamples: number;
    total: number;
    samplesInterval: number;
}

export type ProfileLineMethods = {
    // A resolution is the smallest difference of values to tell apart, by default a tenth of a unit
    formatValue(value: number, resolution?: number): string;
    valueWithUnit(value: number, resolution?: number): { value: string; unit: string };
    // A value on a scale of a length, e.g. a ruler label: the unit follows the scale length rather than the value,
    // a step of the scale gives the fraction digits that tell steps apart
    formatScaleValue(value: number, scaleLength: number, step?: number): string;
    metricName(metric: Metric): string;
    metricDefinition(metric: Metric): string;
}

export type ProfileLineMapping = {
    line: ProfileLine;
    inverse: ProfileLineMapping;
    // Target of every event; an event after the recorded targets maps to their count, e.g. an allocation
    // recorded after the last CPU sample maps to the sample of no time a profile ends with
    _mapping: Uint32Array;
    // Targets never decrease along the events, so events with targets in a range are one interval
    nondecreasing: boolean;
};

export type ProfileLine = {
    type: ProfileLineType;
    kind: LineKind;
    profile: Profile;

    sourceInfo: {
        nodes: number;
        samples: number;
        samplesInterval: number;
    };

    // Axis metadata
    axisStart: number;
    axisStartNoSamples: number;
    axisEnd: number;
    axisEndNoSamples: number;
    axisTotal: number;

    // Stream of signals (e.g. time deltas, memory allocations) for this line in its primary axis
    values: Uint32Array;
    attributes: ProfileLineAttribute[];
    filters: FilterSet;
    // The scope of populations: tables, totals, indicators and filters follow it
    viewport: RangeView;
    // A range displayed within the viewport: zooming changes what timelines show, not populations
    zoom: RangeView;
    // Window of histogram data: the zoom quantized to aligned levels of the viewport, so zooming and panning
    // inside it changes how histograms are displayed, not their data
    window: RangeView;
    range: RangeView;

    // Line-owned tree breakdowns. Several lines may reuse the same tree structure,
    // while keeping independent sample-to-node mappings and metrics.
    breakdowns: ProfileLineBreakdown[];

    // Mappings to other lines (key = target line kind)
    mappings: Record<ProfileLineType, ProfileLineMapping>;

    // Signatures of the line events for repeated aggregation, once breakdowns and filters are prepared
    signatures: EventSignatures | null;
} & ProfileLineMethods;

export type TimelineLine = ProfileLine & {
    type: 'timeline';
    kind: 'time';
};

export type ProfileMemline = ProfileLine & {
    type: 'memline';
    kind: 'memory';
};

export type GcEpochDictEntry = {
    type: 'minor' | 'major' | 'none' | 'unknown'; // 'none' for allocations not collected by GC, 'unknown' for missed epochs
    epoch: number;
    color: string;
};
export type AllocationSpaceDictEntry = {
    code: string;
    name: string;
    color: string;
};
