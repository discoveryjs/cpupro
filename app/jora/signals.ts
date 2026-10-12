import type { Profile } from '../prepare/profile.mjs';
import type { ProfileLine, ProfileLineType, ProfileLineBreakdown, ProfileLineAllocationCompilationStageAttribute } from '../prepare/lines/types.js';
import type { CpuProCompilationRecord, CpuProThread } from '../prepare/types.js';
import { getProfileOrScopeProfile } from './profile.js';

type SignalsProfile = Pick<Profile, 'timeline' | 'memline'> & {
    thread: Pick<CpuProThread, 'compilations'> | null;
};
type MethodContext = Parameters<typeof getProfileOrScopeProfile>[1];
type Method = (this: { context: MethodContext }, ...args: unknown[]) => unknown;

type PlacedRecord = CpuProCompilationRecord & {
    tm: number;
};
type TimedRecord = PlacedRecord & {
    duration: number;
};
type AllocatedRecord = CpuProCompilationRecord & {
    allocationStart: number;
    allocationEnd: number;
};
type OpenEvent = {
    name: string;
    end: number;
    allocationStart: number | null;
    allocationEnd: number | null;
};
type OpenStageEvent = {
    end: number;
    allocationEnd: number;
    stageIndex: number;
};

const NO_STAGE = 'none';
const nestingCache = new WeakMap<CpuProCompilationRecord[], EventNesting>();
const stageMismatchCache = new WeakMap<Profile, number | null>();

function isPlaced(record: CpuProCompilationRecord): record is PlacedRecord {
    return record.tm !== null;
}

export function isTimed(record: CpuProCompilationRecord): record is TimedRecord {
    if (record.tm === null || record.duration === null) {
        return false;
    }

    return record.duration > 0;
}

function isAllocated(record: CpuProCompilationRecord): record is AllocatedRecord {
    const { allocationStart, allocationEnd } = record;

    return allocationStart !== null && allocationEnd !== null && allocationEnd > allocationStart;
}

// Outer events go first, so a parent is always met before its children
function compareByTimeThenLongest(first: PlacedRecord, second: PlacedRecord) {
    return first.tm - second.tm || (second.duration ?? 0) - (first.duration ?? 0);
}

// Events with a known start, instant and unfinished ones included
export function sortPlacedEvents(compilations: CpuProCompilationRecord[]) {
    return compilations.filter(isPlaced).sort(compareByTimeThenLongest);
}

export function countInversions(vector: ArrayLike<number>) {
    let inversions = 0;

    for (let i = 1; i < vector.length; i++) {
        if (vector[i] < vector[i - 1]) {
            inversions++;
        }
    }

    return inversions;
}

function describeRangeViolation(parent: OpenEvent, child: AllocatedRecord) {
    const pair = `${parent.name} -> ${child.name}`;

    if (parent.allocationStart === null || parent.allocationEnd === null) {
        return `${pair} (parent has no allocations)`;
    }

    const startsBefore = child.allocationStart < parent.allocationStart;
    const endsAfter = child.allocationEnd > parent.allocationEnd;

    return startsBefore || endsAfter ? pair : null;
}

// Events of one thread are expected to nest strictly, both in time and in allocation ranges
export function analyzeEventNesting(events: TimedRecord[]) {
    const open: OpenEvent[] = [];
    const rangeViolations = new Map<string, number>();
    let rangeViolationsCount = 0;
    let nestedWithAllocations = 0;
    let partialOverlaps = 0;

    for (const event of events) {
        const end = event.tm + event.duration;
        const allocated = isAllocated(event);
        let parent = open.at(-1);

        while (parent !== undefined && parent.end <= event.tm) {
            open.pop();
            parent = open.at(-1);
        }

        if (parent !== undefined && end > parent.end) {
            partialOverlaps++;
        }

        if (parent !== undefined && allocated) {
            const violation = describeRangeViolation(parent, event);

            nestedWithAllocations++;

            if (violation !== null) {
                rangeViolations.set(violation, (rangeViolations.get(violation) ?? 0) + 1);
                rangeViolationsCount++;
            }
        }

        open.push({
            name: event.name,
            end: parent !== undefined ? Math.min(end, parent.end) : end,
            allocationStart: allocated ? event.allocationStart : null,
            allocationEnd: allocated ? event.allocationEnd : null
        });
    }

    return {
        partialOverlaps,
        nestedWithAllocations,
        rangeViolations,
        rangeViolationsCount
    };
}

function countStageMismatches(
    values: ArrayLike<number>,
    from: number,
    to: number,
    expectedStage: number
) {
    let mismatches = 0;

    for (let i = Math.max(0, from); i < Math.min(values.length, to); i++) {
        if (values[i] !== expectedStage) {
            mismatches++;
        }
    }

    return mismatches;
}

// Verifies allocations strictly left to right: every segment is checked once
class StageScanner {
    values: ArrayLike<number>;
    position = 0;
    mismatches = 0;

    constructor(values: ArrayLike<number>) {
        this.values = values;
    }

    // checks [position, end) against the expected stage and moves the position to the end
    expect(stageIndex: number, end: number) {
        this.mismatches += countStageMismatches(this.values, this.position, end, stageIndex);
        this.position = Math.max(this.position, end);
    }
}

// Walks events in time order, so every allocation is visited once and checked
// against the innermost open event; no per-event or per-allocation temporaries.
// An instant or unfinished event is a leaf: it owns its range but never a parent.
function countStageMismatchesByNesting(
    placedEvents: PlacedRecord[],
    stage: ProfileLineAllocationCompilationStageAttribute
) {
    const stageIndexes = new Map(stage.dict.map((name, index) => [name, index]));
    const noStage = stageIndexes.get(NO_STAGE) ?? 0;
    const open: OpenStageEvent[] = [];
    const scanner = new StageScanner(stage.values);

    for (const event of placedEvents) {
        if (!isAllocated(event)) {
            continue;
        }

        const duration = event.duration ?? 0;
        const leaf = duration <= 0;
        let parent = open.at(-1);

        // a leaf at the very end of a parent still belongs to it
        while (parent !== undefined && (leaf ? parent.end < event.tm : parent.end <= event.tm)) {
            scanner.expect(parent.stageIndex, parent.allocationEnd);
            open.pop();
            parent = open.at(-1);
        }

        const gapOwner = parent !== undefined ? parent.stageIndex : noStage;
        const parentEnd = parent !== undefined ? parent.end : Infinity;
        const stageIndex = stageIndexes.get(event.name) ?? -1;

        scanner.expect(gapOwner, event.allocationStart);

        if (leaf) {
            scanner.expect(stageIndex, event.allocationEnd);
        } else {
            open.push({
                end: Math.min(event.tm + duration, parentEnd),
                allocationEnd: event.allocationEnd,
                stageIndex
            });
        }
    }

    for (let parent = open.pop(); parent !== undefined; parent = open.pop()) {
        scanner.expect(parent.stageIndex, parent.allocationEnd);
    }

    scanner.expect(noStage, stage.values.length);

    return scanner.mismatches;
}

export type EventNesting = {
    partialOverlaps: number;
    nestedWithAllocations: number;
    rangeViolations: number;
};

export function measureEventNesting(compilations: CpuProCompilationRecord[]): EventNesting {
    const nesting = analyzeEventNesting(sortPlacedEvents(compilations).filter(isTimed));

    return {
        partialOverlaps: nesting.partialOverlaps,
        nestedWithAllocations: nesting.nestedWithAllocations,
        rangeViolations: nesting.rangeViolationsCount
    };
}

// Allocations whose stage differs from the innermost event by time nesting;
// null when it cannot be judged (no signals, or ids do not look like 1..N)
export function measureStageMismatches(profile: SignalsProfile): number | null {
    const { timeline, memline, thread } = profile;
    const compilations = thread?.compilations ?? [];
    const stage = memline?.attributes.find(
        (attribute): attribute is ProfileLineAllocationCompilationStageAttribute =>
            attribute.name === 'allocationCompilationStage'
    );
    const mapping = timeline?.mappings.memline?._mapping;

    if (!stage || !mapping || mapping.length === 0 || compilations.length === 0) {
        return null;
    }

    if (allocationSampleWindow(profile) === null) {
        return null;
    }

    return countStageMismatchesByNesting(sortPlacedEvents(compilations), stage);
}

function samplePopulation(line: ProfileLine) {
    return line.breakdowns.find(breakdown =>
        breakdown.kind === (line.type === 'timeline' ? 'call-stack' : 'location')
    ) ?? line.breakdowns[0];
}

function sampleCategoryIndex(breakdown: ProfileLineBreakdown | undefined, index: number) {
    if (!breakdown?.categories) {
        return 0;
    }

    const { tree, sampleToNode } = breakdown.categories;
    const sample = breakdown.population.samples[index];

    return tree.nodes[sampleToNode[sample]];
}

function sampleAxis(line: ProfileLine) {
    const start = line.type === 'timeline' ? line.axisStart + line.axisStartNoSamples : 0;
    const length = line.type === 'timeline' ? line.axisTotal : line.values.length;

    return { start, end: start + length };
}

function binIndex(position: number, start: number, end: number, count: number) {
    const index = Math.floor((position - start) / (end - start || 1) * count);

    return Math.max(0, Math.min(count - 1, index));
}

export function sampleDistribution(profile: Profile, type: ProfileLineType, binCount = 500) {
    const line = profile[type];

    if (!line) {
        return null;
    }

    binCount = Math.max(1, Math.min(1000, Math.floor(binCount) || 500));

    const { start, end } = sampleAxis(line);
    const breakdown = samplePopulation(line);
    const bins = new Uint32Array(binCount);
    const valueBins = new Float64Array(binCount);
    const categories = (breakdown?.categories?.tree.dictionary ?? [null]).map(category => ({
        category,
        total: 0,
        value: 0,
        bins: new Uint32Array(binCount),
        valueBins: new Float64Array(binCount)
    }));
    const sizes = Array.from({ length: 33 }, (_, exponent) => ({
        min: exponent === 0 ? 0 : 2 ** (exponent - 1),
        max: exponent === 0 ? 1 : 2 ** exponent,
        count: 0,
        value: 0
    }));
    let position = start;
    let value = 0;

    for (let index = 0; index < line.values.length; index++) {
        const sampleValue = line.values[index];
        const category = categories[sampleCategoryIndex(breakdown, index)];
        const bin = binIndex(position, start, end, binCount);
        const size = sizes[sampleValue === 0 ? 0 : Math.floor(Math.log2(sampleValue)) + 1];

        category.total++;
        category.value += sampleValue;
        category.bins[bin]++;
        category.valueBins[bin] += sampleValue;
        bins[bin]++;
        valueBins[bin] += sampleValue;
        size.count++;
        size.value += sampleValue;
        value += sampleValue;
        position += line.type === 'timeline' ? sampleValue : 1;
    }

    return { start, end, count: line.values.length, value, categories, bins, valueBins, sizes };
}

type SampleEvents = {
    names: (string | null)[];
    values: ArrayLike<number>;
};

export function allocationSampleWindow(profile: SignalsProfile) {
    const mapping = profile.timeline?.mappings.memline?._mapping;
    const first = mapping?.[0];
    const last = mapping?.[mapping.length - 1];
    const count = profile.memline?.values.length;

    if (!mapping || first === undefined || last === undefined || count === undefined ||
        first < 0 || first > last || last > count || countInversions(mapping) > 0) {
        return null;
    }

    return { start: first, end: last };
}

function cpuSampleEvents(line: ProfileLine, compilations: CpuProCompilationRecord[]): SampleEvents | null {
    const timed = sortPlacedEvents(compilations).filter(isTimed);

    if (compilations.length === 0 || analyzeEventNesting(timed).partialOverlaps > 0) {
        return null;
    }

    const names = [null, ...new Set(timed.map(event => event.name))];
    const nameIds = new Map(names.map((name, index) => [name, index]));
    const values = new Uint32Array(line.values.length);
    const open: { end: number; id: number }[] = [];
    let time = line.axisStart + line.axisStartNoSamples;
    let eventIndex = 0;

    for (let index = 0; index < values.length; index++) {
        while (eventIndex < timed.length && timed[eventIndex].tm <= time) {
            const event = timed[eventIndex++];

            while (open.length > 0 && open[open.length - 1].end <= event.tm) {
                open.pop();
            }

            open.push({ end: event.tm + event.duration, id: nameIds.get(event.name)! });
        }

        while (open.length > 0 && open[open.length - 1].end <= time) {
            open.pop();
        }

        values[index] = open[open.length - 1]?.id ?? 0;
        time += line.values[index];
    }

    return { names, values };
}

function allocationSampleEvents(line: ProfileLine): SampleEvents | null {
    const stage = line.attributes.find(attribute => attribute.name === 'allocationCompilationStage');

    if (!stage || stage.values.length !== line.values.length) {
        return null;
    }

    return { names: stage.dict.map(name => name === NO_STAGE ? null : name), values: stage.values };
}

function countCompilationSamples(
    line: ProfileLine,
    ownership: SampleEvents,
    binCount: number,
    window: ReturnType<typeof allocationSampleWindow>
) {
    const { start, end } = sampleAxis(line);
    const breakdown = samplePopulation(line);
    const categories = (breakdown?.categories?.tree.dictionary ?? [null]).map(category => ({
        category,
        total: 0,
        covered: 0,
        outside: 0,
        before: 0,
        after: 0,
        bins: new Uint32Array(binCount),
        outsideBins: new Uint32Array(binCount)
    }));
    const events = ownership.names.map(name => ({
        name,
        count: 0,
        counts: new Uint32Array(categories.length)
    }));
    const bins = new Uint32Array(binCount);
    const outsideBins = new Uint32Array(binCount);
    let position = start;

    for (let index = 0; index < line.values.length; index++) {
        const categoryIndex = sampleCategoryIndex(breakdown, index);
        const category = categories[categoryIndex];
        const event = events[ownership.values[index]];
        const bin = binIndex(position, start, end, binCount);

        category.total++;
        category.bins[bin]++;
        bins[bin]++;
        event.count++;
        event.counts[categoryIndex]++;

        if (event.name === null) {
            category.outside++;
            category.outsideBins[bin]++;
            outsideBins[bin]++;
            category.before += Number(window !== null && index < window.start);
            category.after += Number(window !== null && index >= window.end);
        } else {
            category.covered++;
        }

        position += line.type === 'timeline' ? line.values[index] : 1;
    }

    return { start, end, window, categories, events, bins, outsideBins };
}

export function samplesByCompilation(profile: Profile, type: ProfileLineType = 'timeline', binCount = 500) {
    const line = profile[type];

    if (!line) {
        return null;
    }

    const ownership = type === 'timeline'
        ? cpuSampleEvents(line, profile.thread?.compilations ?? [])
        : allocationSampleEvents(line);

    if (ownership === null) {
        return null;
    }

    const count = Math.max(1, Math.min(1000, Math.floor(binCount) || 500));
    const window = type === 'memline' ? allocationSampleWindow(profile) : null;

    return countCompilationSamples(line, ownership, count, window);
}

export const methods: Record<string, Method> = {
    allocationSampleWindow(profile: unknown) {
        const target = getProfileOrScopeProfile(profile, this.context);

        return target ? allocationSampleWindow(target) : null;
    },
    sampleDistribution(profile: unknown, type = 'timeline', binCount = 500) {
        const target = getProfileOrScopeProfile(profile, this.context);

        return target && (type === 'timeline' || type === 'memline')
            ? sampleDistribution(target, type, Number(binCount))
            : null;
    },
    samplesByCompilation(profile: unknown, type = 'timeline', binCount = 500) {
        const target = getProfileOrScopeProfile(profile, this.context);

        return target && (type === 'timeline' || type === 'memline')
            ? samplesByCompilation(target, type, Number(binCount))
            : null;
    },
    eventNesting(events: unknown) {
        if (!Array.isArray(events)) {
            return null;
        }

        let nesting = nestingCache.get(events);

        if (nesting === undefined) {
            nesting = measureEventNesting(events);
            nestingCache.set(events, nesting);
        }

        return nesting;
    },
    // The number of neighbours going backwards in a vector of numbers
    inversions(vector: unknown) {
        const isVector = Array.isArray(vector) || ArrayBuffer.isView(vector);

        return isVector ? countInversions(vector as ArrayLike<number>) : null;
    },
    allocationStageMismatches(profile: unknown) {
        const targetProfile = getProfileOrScopeProfile(profile, this.context);

        if (targetProfile === null) {
            return null;
        }

        let mismatches = stageMismatchCache.get(targetProfile);

        if (mismatches === undefined) {
            mismatches = measureStageMismatches(targetProfile);
            stageMismatchCache.set(targetProfile, mismatches);
        }

        return mismatches;
    }
};
