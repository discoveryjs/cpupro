import { Observer, exposeGetters } from './misc.js';
import {
    createPopulationBuffer,
    populationApiOf,
    type PopulationApi,
    type PopulationBuffer
} from './population.compute.js';
import { PopulationFilter, singleEventClass, type EventAcceptance, type EventClasses } from './population-filter.js';
import { PopulationRecords, type RecordSums } from './population-records.js';
import { normalizeRanges, intersectRanges, equalRanges, type RangeSet } from './coordinates.js';

export class Population extends Observer {
    readonly ranges: RangeSet | null = null;
    readonly boundaryCuts: readonly BoundaryCut[] = [];
    readonly sinkId: number;
    readonly sink: { count: number; total: number };
    readonly samplesRevision = 0;
    samples: Uint32Array;
    values: Uint32Array;
    // Prefix sums of values; Float64 keeps them exact beyond 2^32 (up to 2^53)
    cumulative: Float64Array;  // size of values
    // End of the base cumulative axis, not the sum of filtered contributions
    readonly cumulativeEnd: number;
    samplesCount: Uint32Array; // size of samples
    samplesTotal: Float64Array; // size of samples
    readonly records: PopulationRecords; // events by sample and class, read by the populations derived from it
    readonly #classTotals: Float64Array; // per event class: the sum of its event values
    readonly #classCounts: Uint32Array;  // per event class: the number of its events with a nonzero value

    constructor(
        samples: Uint32Array,
        values: Uint32Array,
        sampleCount = findMaxId(samples) + 1,
        cumulative: Float64Array = computeCumulative(values), // shared by the populations over the same values
        classes: EventClasses = singleEventClass(values.length) // shared by the populations of a line
    ) {
        super();

        this.samples = samples;
        this.values = values;
        this.cumulative = cumulative;
        this.cumulativeEnd = computeCumulativeEnd(values, cumulative);
        this.sinkId = sampleCount;

        const samplesCount = new Uint32Array(sampleCount + 1);
        const samplesTotal = new Float64Array(sampleCount + 1);
        this.samplesCount = samplesCount.subarray(0, sampleCount);
        this.samplesTotal = samplesTotal.subarray(0, sampleCount);
        this.records = new PopulationRecords(samples, values, cumulative, this.cumulativeEnd, classes);
        this.#classTotals = new Float64Array(classes.events.length);
        this.#classCounts = new Uint32Array(classes.events.length);

        // PERF: Records already sum the events of every sample and class, a few events per record, so the metrics
        // of samples and the sums of classes are sums of all records rather than another pass over the events
        this.records.sum(
            [[0, this.records.partCount]],
            new Uint8Array(sampleCount).fill(1),
            new Uint8Array(classes.events.length).fill(1),
            {
                sampleTotals: samplesTotal,
                sampleCounts: samplesCount,
                classTotals: this.#classTotals,
                classCounts: this.#classCounts
            }
        );
        this.sink = {
            count: samplesCount[this.sinkId],
            total: samplesTotal[this.sinkId]
        };
    }

    aggregateBy(groups: Uint8Array | Uint32Array, groupCount: number) {
        // Groupings constant within an event class are summed from the sums of classes
        if (this.records.classifies(groups)) {
            const { samplesTotal, samplesCount } = sumClassGroups(
                this.records.classValues(groups),
                this.#classTotals,
                this.#classCounts,
                groupCount
            );

            return {
                samplesCount: samplesCount.subarray(0, groupCount),
                samplesTotal: samplesTotal.subarray(0, groupCount)
            };
        }

        return aggregatePopulation(this, [[0, this.values.length]], groups, groupCount);
    }

    // Events of a few groups, a vector per group: the events the group counts (of a nonzero value and a destination
    // other than the sink) in index order, for walks over the events of a group rather than over all events. Counts
    // of the groups size the vectors, so a single pass over the events fills them
    groupEvents(groups: Uint8Array | Uint32Array, groupCount: number, selected: number[]) {
        const { samples, values, sinkId } = this;
        const { samplesCount } = this.aggregateBy(groups, groupCount);
        const slots = new Uint32Array(groupCount); // per group: 1 + its index in selected
        const offsets = new Uint32Array(selected.length);
        const events: Uint32Array[] = [];

        for (let i = 0; i < selected.length; i++) {
            slots[selected[i]] = i + 1;
            events.push(new Uint32Array(samplesCount[selected[i]]));
        }

        for (let i = 0; i < groups.length; i++) {
            const slot = slots[groups[i]];

            if (slot !== 0 && values[i] !== 0 && samples[i] !== sinkId) {
                events[slot - 1][offsets[slot - 1]++] = i;
            }
        }

        return events;
    }

    // Events of zero weight (e.g. samples with a zero time delta) in index order: they have no extent on the axis,
    // so counts of nonzero values miss them
    get zeroEvents(): Uint32Array {
        if (this.#zeroEvents === null) {
            const { values } = this;
            let count = 0;

            for (let index = 0; index < values.length; index++) {
                count += values[index] === 0 ? 1 : 0;
            }

            const events = new Uint32Array(count);

            for (let index = 0, event = 0; event < count; index++) {
                if (values[index] === 0) {
                    events[event++] = index;
                }
            }

            this.#zeroEvents = events;
        }

        return this.#zeroEvents;
    }

    #zeroEvents: Uint32Array | null = null;
}

type MaskFunction = (mask: Uint32Array) => void;
// The part of an edge event outside the ranges, in whole units of its value, and the exact part inside them
export type BoundaryCut = Readonly<{
    index: number;
    value: number;
    covered: number;
}>;
export type EventReader = {
    destination: (index: number) => number;
    value: (index: number) => number;
};
// Acceptance of samples and event classes by a population and its sources, constant within event classes
type RecordsAcceptance = {
    records: PopulationRecords;
    sampleAccepts: Uint8Array;
    classAccepts: Uint8Array;
    accepts: (index: number) => boolean;
};

export class PopulationFiltered extends Observer {
    population: Population;
    readonly source: Population | PopulationFiltered;
    filter: PopulationFilter;
    samplesMask: Uint32Array;
    samplesRevision = 0;
    cumulative: Float64Array;  // size of values
    #ranges: RangeSet | null = null;
    #effectiveRanges: RangeSet | null = null;
    #coverage: [number, number][] = [];
    #boundaryCuts: BoundaryCut[] = [];
    #hasMask = false;
    #acceptedEvents: EventAcceptance | null = null;
    readonly #records: PopulationRecords; // the base's, read while event acceptance is constant within its classes
    #acceptance: RecordsAcceptance | null = null;
    // Sums of whole covered parts when metrics come from records
    #recordSums: RecordSums | null = null;
    // Event-sized compute workspace; allocated when destinations or values are compiled
    #buffer: PopulationBuffer | null = null;
    #api: PopulationApi | null = null;
    #counts: Uint32Array;        // size of samples plus the sink
    #totals: Float64Array;       // size of samples plus the sink
    #samplesCount: Uint32Array;  // size of samples
    #samplesTotal: Float64Array; // size of samples
    // Destinations, values, acceptance and metrics are computed when read after a change
    #samplesStale = true;
    #valuesStale = true;
    #acceptanceStale = true;
    #metricsStale = true;
    #unsubscribe: () => void;

    constructor(source: Population | PopulationFiltered) {
        super();

        const population = source instanceof PopulationFiltered ? source.population : source;
        const sampleCount = population.samplesCount.length;

        this.source = source;
        this.population = population;
        this.cumulative = source.cumulative;
        this.samplesMask = new Uint32Array(sampleCount);
        this.#counts = new Uint32Array(sampleCount + 1);
        this.#totals = new Float64Array(sampleCount + 1);
        this.#samplesCount = this.#counts.subarray(0, sampleCount);
        this.#samplesTotal = this.#totals.subarray(0, sampleCount);

        const applyFilters = (updateMask: MaskFunction, acceptedEvents: EventAcceptance | null) => {
            const eventsChanged = acceptedEvents !== null || this.#acceptedEvents !== null;

            this.#acceptedEvents = acceptedEvents;
            this.#updateMask(updateMask, eventsChanged);
        };

        this.filter = new PopulationFilter(sampleCount, population.values.length, applyFilters);
        this.filter.setEventClasses(population.records.classes);
        this.#records = population.records;
        this.#setEffectiveRanges(source.ranges);

        let samplesRevision = source.samplesRevision;
        this.#unsubscribe = source.subscribe(() => {
            if (samplesRevision !== source.samplesRevision) {
                samplesRevision = source.samplesRevision;
                this.#samplesChanged();
            }

            this.#setEffectiveRanges(intersectRangeSets(source.ranges, this.#ranges));
            this.notify();
        });

        exposeGetters(this, PopulationFiltered.prototype, [
            'samplesCount',
            'samplesTotal',
            'sink',
            'rangeSamples'
        ]);
    }

    destroy() {
        this.#unsubscribe();
    }

    // Per-sample count and total of accepted events, and the count and total of rejected ones
    get samplesCount(): Uint32Array {
        this.#refreshMetrics();
        return this.#samplesCount;
    }

    get samplesTotal(): Float64Array {
        this.#refreshMetrics();
        return this.#samplesTotal;
    }

    get sink() {
        this.#refreshMetrics();

        return {
            count: this.#counts[this.sinkId],
            total: this.#totals[this.sinkId]
        };
    }

    get sinkId() {
        return this.population.sinkId;
    }

    // Number of covered events with a nonzero value; null without ranges
    get rangeSamples() {
        return this.ranges === null ? null : this.#countCovered();
    }

    get cumulativeEnd(): number {
        return this.population.cumulativeEnd;
    }

    // Intervals [start, end) of the events covered by the ranges, all events without ranges
    get coverage(): readonly (readonly [number, number])[] {
        return this.#coverage;
    }

    // Parts of edge events outside the ranges, in event order: an edge event keeps its whole value and metrics
    // subtract the cut
    get boundaryCuts(): readonly BoundaryCut[] {
        return this.#boundaryCuts;
    }

    // Event-sized compute workspace: destinations, values and per-sample aggregates of the event pass
    get buffer(): PopulationBuffer {
        if (this.#buffer === null) {
            this.#buffer = createPopulationBuffer(this.population.values.length, this.samplesMask.length);
            this.#api = populationApiOf(this.#buffer);
        }

        return this.#buffer;
    }

    // Destinations of events: the sample ID, or sinkId when rejected
    get samples(): Uint32Array {
        if (this.#samplesStale) {
            this.#samplesStale = false;
            this.#compileSamples();
        }

        return this.buffer.samples;
    }

    // Values of covered events; edge events keep whole values
    get values(): Uint32Array {
        if (this.#valuesStale) {
            this.#valuesStale = false;
            this.#compileValues();
        }

        return this.buffer.values;
    }

    // Readers of single events for consumers that read a few events (range and bin edges); with records they
    // derive destinations and values from base events, so all events are not compiled for a few
    eventReader(): EventReader {
        const acceptance = this.#recordsAcceptance();

        if (acceptance === null) {
            const { samples, values } = this;

            return {
                destination: index => samples[index],
                value: index => values[index]
            };
        }

        const { samples, values, sinkId } = this.population;
        const coverage = this.#coverage;

        return {
            destination: index => acceptance.accepts(index) ? samples[index] : sinkId,
            value: index => isCovered(coverage, index) ? values[index] : 0
        };
    }

    aggregateBy(groups: Uint8Array | Uint32Array, groupCount: number) {
        const acceptance = this.#recordsAcceptance();

        // Groupings constant within an event class are summed from the class sums of records
        if (acceptance !== null && acceptance.records.classifies(groups)) {
            const { records } = acceptance;
            const { events } = records.cover(this.#coverage);
            const { classTotals, classCounts } = this.#recordSums ?? this.#sumRecords(acceptance);
            const { samplesTotal, samplesCount } = sumClassGroups(
                records.classValues(groups),
                classTotals,
                classCounts,
                groupCount
            );

            this.#sumEvents(acceptance, events, groups, samplesTotal, samplesCount);

            return {
                samplesCount: samplesCount.subarray(0, groupCount),
                samplesTotal: samplesTotal.subarray(0, groupCount)
            };
        }

        const { samples, values, sinkId } = this;
        const metrics = aggregatePopulation(this, this.#coverage, groups, groupCount);
        const cuts = this.#boundaryCuts;

        for (let i = 0; i < cuts.length; i++) {
            const { index, value } = cuts[i];

            if (samples[index] !== sinkId) {
                const group = groups[index];

                metrics.samplesTotal[group] -= value;
                if (value === values[index]) {
                    metrics.samplesCount[group]--;
                }
            }
        }

        return metrics;
    }

    // Number of events of intervals with a nonzero value that the filters of the population and its sources accept;
    // ranges are left to the intervals. Records count those of whole parts, so destinations are not compiled for a count
    countAccepted(intervals: [number, number][]) {
        const { values, sinkId } = this.population;
        const acceptance = this.#recordsAcceptance();
        let count = 0;

        if (acceptance === null) {
            const { samples } = this;

            for (let i = 0; i < intervals.length; i++) {
                const [start, end] = intervals[i];

                for (let j = start; j < end; j++) {
                    if (values[j] !== 0 && samples[j] !== sinkId) {
                        count++;
                    }
                }
            }

            return count;
        }

        const { records, sampleAccepts, classAccepts, accepts } = acceptance;
        const { parts, events } = records.cover(intervals);

        count += records.count(parts, sampleAccepts, classAccepts);

        for (let i = 0; i < events.length; i++) {
            const [start, end] = events[i];

            for (let j = start; j < end; j++) {
                if (values[j] !== 0 && accepts(j)) {
                    count++;
                }
            }
        }

        return count;
    }

    // Destinations change when the mask rejects other samples or an event acceptance is set or removed
    #updateMask(maskFn: MaskFunction, eventsChanged: boolean) {
        const previousMask = this.samplesMask.slice();

        maskFn(this.samplesMask);
        this.#hasMask = this.#acceptedEvents !== null || !isMaskEmpty(this.samplesMask);

        if (!eventsChanged && !rejectsChanged(previousMask, this.samplesMask)) {
            return;
        }

        this.#samplesChanged();
        this.notify();
    }

    get ranges() {
        return this.#effectiveRanges;
    }

    get requestedRanges() {
        return this.#ranges;
    }

    resetRange() {
        this.setRanges(null);
    }

    setRange(start: number | null, end: number | null) {
        this.setRanges(start === null || end === null ? null : [{ start, end }]);
    }

    setRanges(ranges: RangeSet | null) {
        // One-way compatibility input: coordinate views own requests/frames; this workspace keeps local coverage.
        const next = ranges === null ? null : intersectRanges(normalizeRanges(ranges), { start: 0, end: this.population.cumulativeEnd });

        if (equalRanges(next, this.#ranges)) {
            return;
        }

        this.#ranges = next;
        this.#setEffectiveRanges(intersectRangeSets(this.source.ranges, next));
        this.notify();
    }

    #samplesChanged() {
        this.#samplesStale = true;
        this.samplesRevision++;
        this.#metricsChanged();
    }

    // Acceptance of records, metrics and sums of records are computed again when read
    #metricsChanged() {
        this.#acceptanceStale = true;
        this.#metricsStale = true;
        this.#recordSums = null;
    }

    // Coverage and boundary cuts of the ranges intersected with the source ones
    #setEffectiveRanges(ranges: RangeSet | null) {
        const { coverage, cuts } = computeCoverage(ranges, this.cumulative, this.population.values);

        this.#effectiveRanges = ranges;
        this.#coverage = coverage;
        this.#boundaryCuts = cuts;
        this.#valuesStale = true;
        this.#metricsChanged();
    }

    // Events with a nonzero value in the coverage; records count those of whole parts
    #countCovered() {
        const { values } = this.population;
        const records = this.#records;
        const { parts, events } = records.cover(this.#coverage);
        let count = 0;

        for (let i = 0; i < parts.length; i++) {
            const [start, end] = parts[i];

            for (let j = start; j < end; j++) {
                count += records.partCounts[j];
            }
        }

        for (let i = 0; i < events.length; i++) {
            const [start, end] = events[i];

            for (let j = start; j < end; j++) {
                if (values[j] !== 0) {
                    count++;
                }
            }
        }

        return count;
    }

    // Without own masks and ranges destinations, values and boundary cuts equal the source ones, and so do the metrics
    #adoptsSource() {
        return !this.#hasMask && this.#ranges === null;
    }

    #refreshMetrics() {
        if (!this.#metricsStale) {
            return;
        }

        this.#metricsStale = false;

        if (this.#adoptsSource()) {
            this.#adoptSourceMetrics();
            return;
        }

        const acceptance = this.#recordsAcceptance();

        if (acceptance !== null) {
            this.#sumRecords(acceptance);
        } else {
            this.#computeMetrics();
        }
    }

    #adoptSourceMetrics() {
        const { sink } = this.source;

        this.#counts.set(this.source.samplesCount);
        this.#totals.set(this.source.samplesTotal);
        this.#counts[this.sinkId] = sink.count;
        this.#totals[this.sinkId] = sink.total;
    }

    // Per-sample metrics by the event pass over compiled destinations and values
    #computeMetrics() {
        const { samples, values, buffer } = this;
        const cuts = this.#boundaryCuts;

        buffer.samplesCount.fill(0);
        buffer.samplesTotal.fill(0);
        this.#api!.accumulateSampleMetrics(buffer);

        for (let i = 0; i < cuts.length; i++) {
            const { index, value } = cuts[i];
            const sampleId = samples[index];

            buffer.samplesTotal[sampleId] -= value;

            if (value === values[index]) {
                buffer.samplesCount[sampleId]--;
            }
        }

        this.#counts.set(buffer.samplesCount);
        this.#totals.set(buffer.samplesTotal);
    }

    // Per-sample metrics from the records of whole covered parts and the events of partially covered ones; the
    // sums of whole parts by event class are kept for groupings constant within an event class
    #sumRecords(acceptance: RecordsAcceptance) {
        const { records, sampleAccepts, classAccepts } = acceptance;
        const { samples } = this.population;
        const { parts, events } = records.cover(this.#coverage);
        const classCount = records.classes.events.length;
        const sums = {
            sampleTotals: this.#totals,
            sampleCounts: this.#counts,
            classTotals: new Float64Array(classCount),
            classCounts: new Uint32Array(classCount)
        };

        this.#totals.fill(0);
        this.#counts.fill(0);

        records.sum(parts, sampleAccepts, classAccepts, sums);
        this.#sumEvents(acceptance, events, samples, this.#totals, this.#counts);
        this.#metricsStale = false;
        this.#recordSums = sums;

        return sums;
    }

    // Adds events of intervals by group, rejected ones to the last entry, and subtracts boundary cuts: the same
    // integer sums as the event pass
    #sumEvents(
        acceptance: RecordsAcceptance,
        intervals: [number, number][],
        eventGroups: ArrayLike<number>,
        totals: Float64Array,
        counts: Uint32Array
    ) {
        const { accepts } = acceptance;
        const { values } = this.population;
        const cuts = this.#boundaryCuts;
        const rejected = totals.length - 1;

        for (let i = 0; i < intervals.length; i++) {
            const [start, end] = intervals[i];

            for (let j = start; j < end; j++) {
                const value = values[j];

                if (value !== 0) {
                    const target = accepts(j) ? eventGroups[j] : rejected;

                    totals[target] += value;
                    counts[target]++;
                }
            }
        }

        for (let i = 0; i < cuts.length; i++) {
            const { index, value } = cuts[i];
            const target = accepts(index) ? eventGroups[index] : rejected;

            totals[target] -= value;

            if (value === values[index]) {
                counts[target]--;
            }
        }
    }

    // Acceptance of samples and event classes by this population and its sources, when metrics can come from
    // records: records are set and every event acceptance is constant within an event class
    #recordsAcceptance() {
        if (this.#acceptanceStale) {
            this.#acceptanceStale = false;
            this.#acceptance = this.#computeAcceptance();
        }

        return this.#acceptance;
    }

    #computeAcceptance(): RecordsAcceptance | null {
        const records = this.#records;
        const { ids, events } = records.classes;
        const sampleAccepts = new Uint8Array(this.samplesMask.length).fill(1);
        const classAccepts = new Uint8Array(events.length).fill(1);
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- a cursor over the chain of sources from this one
        let population: Population | PopulationFiltered = this;

        while (population instanceof PopulationFiltered) {
            const acceptedEvents = population.#acceptedEvents;
            const mask = population.samplesMask;

            if (acceptedEvents !== null) {
                const { values, accepts } = acceptedEvents;

                if (!records.classifies(values)) {
                    return null;
                }

                for (let i = 0; i < classAccepts.length; i++) {
                    classAccepts[i] &= accepts[values[events[i]]];
                }
            }

            for (let i = 0; i < sampleAccepts.length; i++) {
                if (mask[i] !== 0) {
                    sampleAccepts[i] = 0;
                }
            }

            population = population.source;
        }

        const { samples } = this.population;

        return {
            records,
            sampleAccepts,
            classAccepts,
            accepts: index => (sampleAccepts[samples[index]] & classAccepts[ids[index]]) === 1
        };
    }

    #compileSamples() {
        const sourceSamples = this.source.samples;
        const samples = this.buffer.samples;

        // Without own masks and event acceptance every event keeps the source destination
        if (!this.#hasMask) {
            samples.set(sourceSamples);
            return;
        }

        const sinkId = this.sinkId;
        const samplesMask = this.samplesMask;
        const eventValues = this.#acceptedEvents?.values ?? null;
        const eventAccepts = this.#acceptedEvents?.accepts ?? null;

        for (let i = 0; i < samples.length; i++) {
            const sampleId = sourceSamples[i];

            samples[i] = sampleId !== sinkId && samplesMask[sampleId] === 0 &&
                (eventValues === null || eventAccepts![eventValues[i]] === 1) ? sampleId : sinkId;
        }
    }

    // Values of covered events; edge events keep whole values and metrics subtract their boundary cuts
    #compileValues() {
        const baseValues = this.population.values;
        const values = this.buffer.values;
        const coverage = this.#coverage;
        let clearedEnd = 0;

        for (let i = 0; i < coverage.length; i++) {
            const [start, end] = coverage[i];

            values.fill(0, clearedEnd, start);
            clearedEnd = end;

            for (let j = start; j < end; j++) {
                values[j] = baseValues[j];
            }
        }

        values.fill(0, clearedEnd);
    }
}

// Event intervals of ranges and boundary cuts of their edge events: an edge event keeps its whole value and the
// part of it outside the ranges is cut. Zero-sized events repeat coordinates, so an interval starts at the last
// event starting at or before the range start and ends before the first event starting at its end.
function computeCoverage(ranges: RangeSet | null, cumulative: Float64Array, values: Uint32Array) {
    const coverage: [number, number][] = [];
    const cuts: BoundaryCut[] = [];
    const addCut = (index: number, contribution: number) => {
        const value = values[index];

        if (value > 0) {
            const covered = Math.min(value, Math.max(0, contribution));
            const cut = value - Math.trunc(covered);

            if (cut > 0) {
                cuts.push({
                    index,
                    value: cut,
                    covered
                });
            }
        }
    };

    if (ranges === null) {
        coverage.push([0, values.length]);
        return { coverage, cuts };
    }

    // Successive intervals can touch the same event; its contributions are summed before cutting
    let boundaryIndex = -1;
    let boundaryValue = 0;
    const addBoundary = (index: number, contribution: number) => {
        if (index !== boundaryIndex) {
            if (boundaryIndex !== -1) {
                addCut(boundaryIndex, boundaryValue);
            }

            boundaryIndex = index;
            boundaryValue = 0;
        }

        boundaryValue += contribution;
    };

    for (let i = 0; i < ranges.length; i++) {
        const { start, end } = ranges[i];
        const first = Math.max(0, findCumulativeBoundary(cumulative, start, true) - 1);
        const last = findCumulativeBoundary(cumulative, end, false) - 1;
        const previous = coverage[coverage.length - 1];

        if (previous !== undefined && first < previous[1]) {
            previous[1] = Math.max(previous[1], last + 1);
        } else {
            coverage.push([first, Math.max(first, last) + 1]);
        }

        addBoundary(first, Math.min(cumulative[first] + values[first], end) - start);

        if (last !== first) {
            addBoundary(last, end - cumulative[last]);
        }
    }

    if (boundaryIndex !== -1) {
        addCut(boundaryIndex, boundaryValue);
    }

    return { coverage, cuts };
}

function isCovered(coverage: [number, number][], index: number) {
    for (const [start, end] of coverage) {
        if (index < end) {
            return index >= start;
        }
    }

    return false;
}

function aggregateRange(
    samples: Uint32Array,
    values: Uint32Array,
    groups: Uint8Array | Uint32Array,
    sinkId: number,
    samplesCount: Uint32Array,
    samplesTotal: Float64Array,
    start: number,
    end: number
) {
    for (let i = start; i < end; i++) {
        const value = values[i];

        if (value !== 0 && samples[i] !== sinkId) {
            const group = groups[i];

            samplesCount[group]++;
            samplesTotal[group] += value;
        }
    }
}

// Sums of groups from the sums of event classes and the group of every class, with an entry after the groups
// for the events a population rejects
function sumClassGroups(
    classGroups: Uint32Array,
    classTotals: Float64Array,
    classCounts: Uint32Array,
    groupCount: number
) {
    const samplesTotal = new Float64Array(groupCount + 1);
    const samplesCount = new Uint32Array(groupCount + 1);

    for (let i = 0; i < classGroups.length; i++) {
        const group = classGroups[i];

        samplesTotal[group] += classTotals[i];
        samplesCount[group] += classCounts[i];
    }

    return { samplesTotal, samplesCount };
}

function aggregatePopulation(
    population: Population | PopulationFiltered,
    coverage: readonly (readonly [number, number])[],
    groups: Uint8Array | Uint32Array,
    groupCount: number
) {
    const { samples, values, sinkId } = population;
    const samplesCount = new Uint32Array(groupCount);
    const samplesTotal = new Float64Array(groupCount);

    for (let i = 0; i < coverage.length; i++) {
        aggregateRange(samples, values, groups, sinkId, samplesCount, samplesTotal, coverage[i][0], coverage[i][1]);
    }

    return { samplesCount, samplesTotal };
}

function intersectRangeSets(source: RangeSet | null, ranges: RangeSet | null): RangeSet | null {
    if (source === null) {
        return ranges;
    }

    if (ranges === null) {
        return source;
    }

    const result: { start: number; end: number }[] = [];
    let sourceIndex = 0;
    let rangeIndex = 0;

    while (sourceIndex < source.length && rangeIndex < ranges.length) {
        const parent = source[sourceIndex];
        const own = ranges[rangeIndex];
        const start = Math.max(parent.start, own.start);
        const end = Math.min(parent.end, own.end);

        if (start < end) {
            result.push({ start, end });
        }

        if (parent.end <= own.end) {
            sourceIndex++;
        } else {
            rangeIndex++;
        }
    }

    return normalizeRanges(result);
}

export function computeCumulative(values: Uint32Array) {
    const cumulative = new Float64Array(values.length);
    let sum = 0;

    // PERF: A running sum keeps the previous position in a register rather than reading back the one just stored
    for (let i = 0; i < values.length; i++) {
        cumulative[i] = sum;
        sum += values[i];
    }

    return cumulative;
}

// End of the prefix sums of values: the sum of all values
export function computeCumulativeEnd(values: Uint32Array, cumulative: Float64Array) {
    return values.length > 0
        ? cumulative[values.length - 1] + values[values.length - 1]
        : 0;
}

export function findCumulativeBoundary(cumulative: Float64Array, value: number, afterEqual: boolean) {
    let left = 0;
    let right = cumulative.length;

    while (left < right) {
        const middle = left + ((right - left) >>> 1);
        const coordinate = cumulative[middle];

        if (coordinate < value || (afterEqual && coordinate === value)) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    return left;
}

function findMaxId(samples: Uint32Array) {
    let maxSampleId = 0;

    for (let i = 0; i < samples.length; i++) {
        if (samples[i] > maxSampleId) {
            maxSampleId = samples[i];
        }
    }

    return maxSampleId;
}

// Some sample is rejected by one mask and accepted by the other
function rejectsChanged(previous: Uint32Array, mask: Uint32Array) {
    for (let i = 0; i < mask.length; i++) {
        if ((previous[i] === 0) !== (mask[i] === 0)) {
            return true;
        }
    }

    return false;
}

function isMaskEmpty(mask: Uint32Array) {
    for (let i = 0; i < mask.length; i++) {
        if (mask[i] !== 0) {
            return false;
        }
    }

    return true;
}
