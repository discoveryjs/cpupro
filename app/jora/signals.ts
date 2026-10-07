import type { Profile } from '../prepare/profile.mjs';
import type {
    ProfileLineAllocationCompilationStageAttribute,
    ProfileMemline,
    TimelineLine
} from '../prepare/lines/types.js';
import type { CpuProCompilationRecord, CpuProThread } from '../prepare/types.js';
import { getProfileOrScopeProfile } from './profile.js';

export type SignalCheck = {
    id: string;
    title: string;
    status: 'ok' | 'warn' | 'info';
    count: number | null;
    total: number | null;
    detail: string;
};

type CheckInput = {
    id: string;
    title: string;
    detail: string;
    count?: number | null;
    total?: number | null;
};
type IntegrityProfile = Pick<Profile, 'timeline' | 'memline'> & {
    thread: Pick<CpuProThread, 'compilations'> | null;
};
type MethodContext = Parameters<typeof getProfileOrScopeProfile>[1];
type Method = (this: { context: MethodContext }, ...args: unknown[]) => unknown;

type TimedRecord = CpuProCompilationRecord & {
    tm: number;
    duration: number;
};
type AllocatedRecord = CpuProCompilationRecord & {
    allocationStart: number;
    allocationEnd: number;
};
type AllocationRange = 'missing' | 'empty' | 'inverted' | 'covering';
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

const LONG_DELTA_FACTOR = 2.5;
const NO_STAGE = 'none';
const cache = new WeakMap<Profile, SignalCheck[]>();

function info(input: CheckInput): SignalCheck {
    return {
        id: input.id,
        title: input.title,
        status: 'info',
        count: input.count ?? null,
        total: input.total ?? null,
        detail: input.detail
    };
}

function expectNone(input: CheckInput & { count: number }): SignalCheck {
    const status = input.count === 0 ? 'ok' : 'warn';

    return {
        id: input.id,
        title: input.title,
        status,
        count: input.count,
        total: input.total ?? null,
        detail: input.detail
    };
}

function percent(value: number, total: number) {
    if (total === 0) {
        return '-';
    }

    return (value / total * 100).toFixed(1) + '%';
}

function milliseconds(value: number) {
    return (value / 1000).toFixed(1) + ' ms';
}

function isTimed(record: CpuProCompilationRecord): record is TimedRecord {
    if (record.tm === null || record.duration === null) {
        return false;
    }

    return record.duration > 0;
}

function classifyAllocationRange(record: CpuProCompilationRecord): AllocationRange {
    const { allocationStart, allocationEnd } = record;

    if (allocationStart === null || allocationEnd === null) {
        return 'missing';
    }

    if (allocationEnd < allocationStart) {
        return 'inverted';
    }

    if (allocationEnd === allocationStart) {
        return 'empty';
    }

    return 'covering';
}

function isAllocated(record: CpuProCompilationRecord): record is AllocatedRecord {
    return classifyAllocationRange(record) === 'covering';
}

// Outer events go first, so a parent is always met before its children
function compareByTimeThenLongest(first: TimedRecord, second: TimedRecord) {
    return first.tm - second.tm || second.duration - first.duration;
}

export function sortTimedEvents(compilations: CpuProCompilationRecord[]) {
    return compilations.filter(isTimed).sort(compareByTimeThenLongest);
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

function checkTimeline(timeline: TimelineLine): SignalCheck[] {
    const { values, axisStartNoSamples, axisEndNoSamples, axisTotal } = timeline;
    const longDeltaLimit = LONG_DELTA_FACTOR * timeline.sourceInfo.samplesInterval;
    let longDeltas = 0;
    let longDeltasTime = 0;

    for (let i = 0; i < values.length; i++) {
        if (values[i] > longDeltaLimit) {
            longDeltas++;
            longDeltasTime += values[i];
        }
    }

    return [
        info({
            id: 'samples-lead',
            title: 'Time before the first sample',
            detail: milliseconds(axisStartNoSamples)
        }),
        info({
            id: 'samples-tail',
            title: 'Time after the last sample',
            detail: milliseconds(axisEndNoSamples)
        }),
        info({
            id: 'samples-long-deltas',
            title: `Long sample deltas (> ${LONG_DELTA_FACTOR} intervals)`,
            count: longDeltas,
            total: values.length,
            detail: `${longDeltas} samples, ${percent(longDeltasTime, axisTotal)} of the time`
        })
    ];
}

function checkMappings(timeline: TimelineLine, memline: ProfileMemline): SignalCheck[] {
    const toSample = memline.mappings.timeline?._mapping;
    const toAllocation = timeline.mappings.memline?._mapping;

    if (!toSample || !toAllocation) {
        return [];
    }

    const toSampleInversions = countInversions(toSample);
    const toAllocationInversions = countInversions(toAllocation);

    return [
        expectNone({
            id: 'mapping-allocation-to-sample',
            title: 'Mapping allocation -> sample is monotone',
            count: toSampleInversions,
            total: toSample.length,
            detail: `${toSampleInversions} inversions`
        }),
        expectNone({
            id: 'mapping-sample-to-allocation',
            title: 'Mapping sample -> allocation is monotone',
            count: toAllocationInversions,
            total: toAllocation.length,
            detail: `${toAllocationInversions} inversions`
        })
    ];
}

function checkEventNesting(timedEvents: TimedRecord[], total: number): SignalCheck[] {
    const nesting = analyzeEventNesting(timedEvents);
    const worst = [...nesting.rangeViolations]
        .sort((first, second) => second[1] - first[1])
        .slice(0, 3)
        .map(([pair, count]) => `${pair} ${count}`);
    const worstDetail = worst.length > 0 ? `; worst: ${worst.join('; ')}` : '';
    const nested = nesting.nestedWithAllocations;
    const violations = nesting.rangeViolationsCount;

    return [
        expectNone({
            id: 'events-nesting',
            title: 'Events nest strictly in time',
            count: nesting.partialOverlaps,
            total,
            detail: `${nesting.partialOverlaps} partial overlaps of ${total}`
        }),
        expectNone({
            id: 'events-allocation-nesting',
            title: 'Allocation range is inside the time parent range',
            count: violations,
            total: nested,
            detail: `${violations} of ${nested} nested events with allocations${worstDetail}`
        })
    ];
}

function checkEventAllocations(compilations: CpuProCompilationRecord[]): SignalCheck[] {
    let withoutDuration = 0;
    let withAllocations = 0;
    let inverted = 0;

    for (const record of compilations) {
        const range = classifyAllocationRange(record);

        if (!isTimed(record)) {
            withoutDuration++;
        }

        if (range === 'covering') {
            withAllocations++;
        } else if (range === 'inverted') {
            inverted++;
        }
    }

    const total = compilations.length;

    return [
        info({
            id: 'events-without-duration',
            title: 'Events without duration',
            count: withoutDuration,
            total,
            detail: `${withoutDuration} of ${total}`
        }),
        info({
            id: 'events-with-allocations',
            title: 'Events covering at least one allocation',
            count: withAllocations,
            total,
            detail: `${withAllocations} of ${total}`
        }),
        expectNone({
            id: 'events-allocation-range-inverted',
            title: 'Events with an inverted allocation range',
            count: inverted,
            total,
            detail: String(inverted)
        })
    ];
}

function checkEventsAgainstAxis(timedEvents: TimedRecord[], total: number, timeline: TimelineLine) {
    const { axisStart, axisEnd, sourceInfo } = timeline;
    let before = 0;
    let after = 0;
    let furthest = 0;

    for (const event of timedEvents) {
        if (event.tm < axisStart) {
            before++;
            furthest = Math.max(furthest, axisStart - event.tm);
        } else if (event.tm > axisEnd) {
            after++;
            furthest = Math.max(furthest, event.tm - axisEnd);
        }
    }

    const furthestIntervals = (furthest / sourceInfo.samplesInterval).toFixed(2);

    return expectNone({
        id: 'events-outside-axis',
        title: 'Events outside the sample time axis',
        count: before + after,
        total,
        detail: [
            `${before} before, ${after} after, of ${total};`,
            `furthest ${milliseconds(furthest)} (${furthestIntervals} intervals)`
        ].join(' ')
    });
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

function indexStageNames(dict: string[]) {
    const indexes = new Map<string, number>();

    for (let i = 0; i < dict.length; i++) {
        indexes.set(dict[i], i);
    }

    return indexes;
}

// Walks events in time order, so every allocation is visited once and checked
// against the innermost open event; no per-event or per-allocation temporaries
function countStageMismatchesByNesting(
    timedEvents: TimedRecord[],
    stage: ProfileLineAllocationCompilationStageAttribute
) {
    const stageIndexes = indexStageNames(stage.dict);
    const noStage = stageIndexes.get(NO_STAGE) ?? 0;
    const open: OpenStageEvent[] = [];
    const scanner = new StageScanner(stage.values);

    for (const event of timedEvents) {
        if (!isAllocated(event)) {
            continue;
        }

        let parent = open.at(-1);

        while (parent !== undefined && parent.end <= event.tm) {
            scanner.expect(parent.stageIndex, parent.allocationEnd);
            open.pop();
            parent = open.at(-1);
        }

        const gapOwner = parent !== undefined ? parent.stageIndex : noStage;
        const parentEnd = parent !== undefined ? parent.end : Infinity;

        scanner.expect(gapOwner, event.allocationStart);
        open.push({
            end: Math.min(event.tm + event.duration, parentEnd),
            allocationEnd: event.allocationEnd,
            stageIndex: stageIndexes.get(event.name) ?? -1
        });
    }

    for (let parent = open.pop(); parent !== undefined; parent = open.pop()) {
        scanner.expect(parent.stageIndex, parent.allocationEnd);
    }

    scanner.expect(noStage, stage.values.length);

    return scanner.mismatches;
}

function looksLikeConsecutiveIds(lastMappedId: number, allocationsCount: number) {
    const withinCount = lastMappedId <= allocationsCount;
    const nearCount = lastMappedId > allocationsCount * 0.9;

    return withinCount && nearCount;
}

// The model does not keep allocation ids, so they are assumed to be 1..N
function checkStageAttribute(
    timedEvents: TimedRecord[],
    timeline: TimelineLine,
    memline: ProfileMemline
): SignalCheck[] {
    const id = 'allocation-stage-attribute';
    const title = 'Allocation stage matches the innermost event by time nesting';
    const stage = memline.attributes.find(
        (attribute): attribute is ProfileLineAllocationCompilationStageAttribute =>
            attribute.name === 'allocationCompilationStage'
    );
    const mapping = timeline.mappings.memline?._mapping;

    if (!stage || !mapping || mapping.length === 0) {
        return [];
    }

    const count = stage.values.length;
    const lastMappedId = mapping[mapping.length - 1];

    if (!looksLikeConsecutiveIds(lastMappedId, count)) {
        return [info({
            id,
            title,
            total: count,
            detail: `skipped: ids do not look like 1..N (last mapped ${lastMappedId} of ${count})`
        })];
    }

    const mismatches = countStageMismatchesByNesting(timedEvents, stage);

    return [expectNone({
        id,
        title,
        count: mismatches,
        total: count,
        detail: `${mismatches} of ${count} (${percent(mismatches, count)})`
    })];
}

function checkEvents(
    compilations: CpuProCompilationRecord[],
    timeline: TimelineLine | null,
    memline: ProfileMemline | null
): SignalCheck[] {
    const timedEvents = sortTimedEvents(compilations);
    const checks = [
        ...checkEventNesting(timedEvents, compilations.length),
        ...checkEventAllocations(compilations)
    ];

    if (timeline !== null) {
        checks.push(checkEventsAgainstAxis(timedEvents, compilations.length, timeline));
    }

    if (timeline !== null && memline !== null) {
        checks.push(...checkStageAttribute(timedEvents, timeline, memline));
    }

    return checks;
}

export function checkSignalIntegrity(profile: IntegrityProfile): SignalCheck[] {
    const { timeline, memline, thread } = profile;
    const compilations = thread?.compilations ?? [];
    const checks: SignalCheck[] = [];

    if (timeline !== null) {
        checks.push(...checkTimeline(timeline));
    }

    if (timeline !== null && memline !== null) {
        checks.push(...checkMappings(timeline, memline));
    }

    if (compilations.length > 0) {
        checks.push(...checkEvents(compilations, timeline, memline));
    }

    return checks;
}

export const methods: Record<string, Method> = {
    signalIntegrity(profile: unknown) {
        const targetProfile = getProfileOrScopeProfile(profile, this.context);

        if (targetProfile === null) {
            return [];
        }

        let checks = cache.get(targetProfile);

        if (checks === undefined) {
            checks = checkSignalIntegrity(targetProfile);
            cache.set(targetProfile, checks);
        }

        return checks;
    }
};
