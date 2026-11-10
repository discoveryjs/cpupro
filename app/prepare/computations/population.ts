import { USE_WASM } from '../const.js';
import { Observer } from './misc.js';
import { PopulationBufferMap, createJavaScriptApi, createWasmApi, type ComputeApi } from './compute-wasm-wrapper.js';
import { PopulationFilter, type EventAcceptance } from './population-filter.js';
import { RecordsAggregate, type PopulationRecords } from './population-records.js';
import { normalizeRanges, intersectRanges, equalRanges, type RangeSet } from './coordinates.js';

const computeMetricsJavaScriptApi = createJavaScriptApi();

export class Population extends Observer {
    readonly ranges: RangeSet | null = null;
    readonly boundaryCuts: readonly Readonly<{ index: number; value: number }>[] = [];
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

    constructor(
        samples: Uint32Array,
        values: Uint32Array,
        sampleCount = findMaxId(samples) + 1,
        // Populations over the same values share their prefix sums
        cumulative: Float64Array = computeCumulative(values)
    ) {
        super();

        this.samples = samples;
        this.values = values;
        this.cumulative = cumulative;
        this.cumulativeEnd = values.length ? this.cumulative[values.length - 1] + values[values.length - 1] : 0;
        this.sinkId = sampleCount;

        const samplesCount = new Uint32Array(sampleCount + 1);
        const samplesTotal = new Float64Array(sampleCount + 1);
        this.samplesCount = samplesCount.subarray(0, sampleCount);
        this.samplesTotal = samplesTotal.subarray(0, sampleCount);

        computeMetricsJavaScriptApi.computeMetrics({
            memory: null,
            values: this.values,
            samples: this.samples,
            samplesCount,
            samplesTotal
        }, false);
        this.sink = {
            count: samplesCount[this.sinkId],
            total: samplesTotal[this.sinkId]
        };
    }

    aggregateBy(groups: Uint8Array | Uint32Array, groupCount: number) {
        return aggregatePopulation(this, groups, groupCount);
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

export type MaskFunction = (mask: Uint32Array) => void;
export class PopulationFiltered extends Observer {
    population: Population;
    readonly source: Population | PopulationFiltered;
    filter: PopulationFilter;
    readonly sink: { count: number; total: number };
    // Event-sized compute workspace; allocated when destinations or values are compiled
    #buffer: PopulationBufferMap | null = null;
    #api: ComputeApi | null = null;
    #counts: Uint32Array;      // size of samples plus the sink
    #totals: Float64Array;     // size of samples plus the sink
    #recompute: (clear?: boolean) => void;
    #hasMask = false;
    #acceptedEvents: EventAcceptance | null = null;
    #unsubscribe: () => void;
    #boundaryCuts: { index: number; value: number }[] = [];
    samplesRevision = 0;
    // Destinations and values are compiled when an event-sized consumer reads them; until a workspace is
    // allocated both are stale
    #samplesStale = true;
    #valuesStale = true;
    #aggregate: RecordsAggregate | null = null;
    #acceptance: RecordsAcceptance | null = null;
    #coverage: [number, number][] = [];
    cumulative: Float64Array;  // size of values
    samplesCount: Uint32Array; // size of samples
    samplesTotal: Float64Array; // size of samples
    samplesMask: Uint32Array;
    #ranges: RangeSet | null = null;
    #effectiveRanges: RangeSet | null = null;
    rangeSamples: number | null = null;

    constructor(source: Population | PopulationFiltered) {
        super();

        const sampleCount = source.samplesCount.length;

        this.source = source;
        this.population = source instanceof PopulationFiltered ? source.population : source;
        this.cumulative = source.cumulative;
        this.#counts = new Uint32Array(sampleCount + 1);
        this.#totals = new Float64Array(sampleCount + 1);
        this.samplesCount = this.#counts.subarray(0, sampleCount);
        this.samplesTotal = this.#totals.subarray(0, sampleCount);
        this.samplesMask = new Uint32Array(sampleCount);

        this.#recompute = (clear = true) => {
            const tables = this.#recordsTables();

            if (tables !== null) {
                this.#coverRecords(tables);
            }

            if (this.#adoptsSource()) {
                this.#adoptSourceMetrics();
                return;
            }

            if (tables !== null) {
                this.#computeMetricsFromRecords();
                return;
            }

            const { samples, values } = this;
            const buffer = this.buffer;

            this.#api!.computeMetrics(buffer, clear);

            for (const { index, value } of this.#boundaryCuts) {
                const sampleId = samples[index];

                buffer.samplesTotal[sampleId] -= value;

                if (value === values[index]) {
                    buffer.samplesCount[sampleId]--;
                }
            }

            this.#counts.set(buffer.samplesCount);
            this.#totals.set(buffer.samplesTotal);
        };

        this.filter = new PopulationFilter(
            sampleCount,
            this.population.values.length,
            (updateMask, acceptedEvents) => {
                this.#acceptedEvents = acceptedEvents;
                this.#updateMask(updateMask);
            }
        );

        this.#effectiveRanges = source.ranges;

        // Without source ranges values equal the source values, and metrics are the source ones
        if (source.ranges === null) {
            this.#adoptSourceMetrics();
        } else {
            this.#valuesStale = false;
            this.#compileValues();
            this.#recompute();
        }

        let samplesRevision = source.samplesRevision;
        this.#unsubscribe = source.subscribe(() => {
            if (samplesRevision !== source.samplesRevision) {
                samplesRevision = source.samplesRevision;
                this.#updateSamples();
            }

            this.#effectiveRanges = intersectRangeSets(source.ranges, this.#ranges);
            this.#updateValues();
            this.#recompute();
            this.notify();
        });

        Object.defineProperty(this, 'sink', {
            get: () => this.#sink
        });
    }

    destroy() {
        this.#unsubscribe();
    }

    // Event-sized compute workspace: destinations, values and per-sample aggregates of the event pass
    get buffer(): PopulationBufferMap {
        if (this.#buffer === null) {
            this.#buffer = createComputeBuffer(this.population.values.length, this.samplesMask.length, USE_WASM);
            this.#api = USE_WASM && this.#buffer.memory
                ? createWasmApi(this.#buffer.memory)
                : computeMetricsJavaScriptApi;
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

    // Values of events after ranges; edge events keep whole values (see boundaryCuts)
    get values(): Uint32Array {
        if (this.#valuesStale) {
            this.#valuesStale = false;
            this.#compileValues();
        }

        return this.buffer.values;
    }

    // Readers of single events for consumers that read a few events (range and bin edges): they read compiled
    // destinations and values, or derive them when metrics came from records, without compiling all events
    eventReader(): EventReader {
        const { samples: baseSamples, values: baseValues, sinkId } = this.population;
        const acceptance = this.#acceptance;
        const coverage = this.#coverage;
        const samples = this.#samplesStale && acceptance !== null ? null : this.samples;
        const values = this.#valuesStale && acceptance !== null ? null : this.values;

        return {
            destination: samples !== null
                ? index => samples[index]
                : index => acceptance!.accepts(index, baseSamples[index]) ? baseSamples[index] : sinkId,
            value: values !== null
                ? index => values[index]
                : index => isCovered(coverage, index) ? baseValues[index] : 0
        };
    }

    // Records of the base population grouped by event classes; with them, metrics are computed from records
    // while destinations follow per-sample and per-class acceptance
    setRecords(records: PopulationRecords | null) {
        this.#aggregate = records !== null && records.samples === this.population.samples
            ? new RecordsAggregate(records)
            : null;

        // Coverage and acceptance of records let single-event readers avoid compiling all events
        if (this.#recordsTables() !== null) {
            this.#recompute();
        }
    }

    aggregateBy(groups: Uint8Array | Uint32Array, groupCount: number) {
        const metrics = aggregatePopulation(this, groups, groupCount);

        for (const { index, value } of this.#boundaryCuts) {
            if (this.samples[index] !== this.sinkId) {
                const group = groups[index];

                metrics.samplesTotal[group] -= value;
                if (value === this.values[index]) {
                    metrics.samplesCount[group]--;
                }
            }
        }

        return metrics;
    }

    get boundaryCuts(): readonly Readonly<{ index: number; value: number }>[] {
        return this.#boundaryCuts;
    }

    get cumulativeEnd(): number {
        return this.population.cumulativeEnd;
    }

    get sinkId() {
        return this.population.sinkId;
    }

    get #sink() {
        return {
            count: this.#counts[this.sinkId],
            total: this.#totals[this.sinkId]
        };
    }

    #updateMask(maskFn: MaskFunction) {
        const hadMask = this.#hasMask;

        maskFn(this.samplesMask);
        this.#hasMask = this.#acceptedEvents !== null || !isMaskEmpty(this.samplesMask);

        if (!this.#hasMask && !hadMask) {
            return;
        }

        if (this.#updateSamples()) {
            this.#recompute();
            this.notify();
        }
    }

    // Destinations are compiled now, or marked stale when metrics come from records
    #updateSamples() {
        if (this.#recordsTables() !== null) {
            this.#samplesStale = true;
            this.samplesRevision++;

            return true;
        }

        const wasStale = this.#samplesStale;

        this.#samplesStale = false;

        return this.#compileSamples() || wasStale;
    }

    #updateValues() {
        if (this.#recordsTables() !== null) {
            this.#valuesStale = true;
        } else {
            this.#valuesStale = false;
            this.#compileValues();
        }
    }

    #compileSamples() {
        const originalSamples = this.source.samples;
        const samples = this.buffer.samples;

        // Without own masks and event acceptance every event keeps the source destination
        if (!this.#hasMask) {
            samples.set(originalSamples);
            this.samplesRevision++;

            return true;
        }

        const sinkId = this.sinkId;
        const samplesMask = this.samplesMask;
        const eventValues = this.#acceptedEvents?.values ?? null;
        const eventAccepts = this.#acceptedEvents?.accepts ?? null;
        let changed = false;

        for (let i = 0; i < samples.length; i++) {
            const sampleId = originalSamples[i];
            const target = sampleId !== sinkId && samplesMask[sampleId] === 0 &&
                (eventValues === null || eventAccepts![eventValues[i]] === 1) ? sampleId : sinkId;

            changed = changed || samples[i] !== target;
            samples[i] = target;
        }

        if (changed) {
            this.samplesRevision++;
        }

        return changed;
    }

    // Without own masks and ranges destinations, values and boundary cuts equal the source ones, and so do the metrics
    #adoptsSource() {
        return !this.#hasMask && this.#ranges === null;
    }

    #adoptSourceMetrics() {
        const { sink } = this.source;

        this.#counts.set(this.source.samplesCount);
        this.#totals.set(this.source.samplesTotal);
        this.#counts[this.sinkId] = sink.count;
        this.#totals[this.sinkId] = sink.total;
    }

    // Per-sample masks and event acceptances along the source chain, when metrics can come from records:
    // records are set and every event acceptance is constant within an event class
    #recordsTables(): RecordsTables | null {
        const aggregate = this.#aggregate;

        if (aggregate === null) {
            return null;
        }

        const source = this.source instanceof PopulationFiltered
            ? this.source.#recordsTables()
            : { masks: [], events: [] };

        if (source === null) {
            return null;
        }

        const events = this.#acceptedEvents !== null
            ? [...source.events, this.#acceptedEvents]
            : source.events;

        if (!events.every(({ values }) => aggregate.records.classifies(values))) {
            return null;
        }

        return { masks: [...source.masks, this.samplesMask], events };
    }

    // Covers the events of the effective ranges by records and computes boundary cuts and rangeSamples
    // as #compileValues does, reading event values only at range edges
    #coverRecords({ masks, events }: RecordsTables) {
        const aggregate = this.#aggregate!;
        const { records } = aggregate;
        const { classes } = records;
        const sampleAccepts = new Uint8Array(this.samplesMask.length).fill(1);
        const classAccepts = new Uint8Array(classes.events.length).fill(1);
        const { coverage, cuts } = computeCoverage(this.ranges, this.cumulative, this.population.values);

        for (const mask of masks) {
            for (let sampleId = 0; sampleId < mask.length; sampleId++) {
                if (mask[sampleId] !== 0) {
                    sampleAccepts[sampleId] = 0;
                }
            }
        }

        for (const { values, accepts } of events) {
            for (let eventClass = 0; eventClass < classAccepts.length; eventClass++) {
                classAccepts[eventClass] &= accepts[values[classes.events[eventClass]]];
            }
        }

        aggregate.cover(coverage);
        this.#coverage = coverage;
        this.#boundaryCuts = cuts;
        this.#acceptance = {
            sampleAccepts,
            classAccepts,
            accepts: (index, sampleId) => sampleAccepts[sampleId] === 1 && classAccepts[classes.ids[index]] === 1
        };

        if (this.ranges === null) {
            this.rangeSamples = null;
        } else {
            const { values } = this.population;
            let rangeSamples = aggregate.count;

            for (const [start, end] of aggregate.partialIntervals) {
                for (let index = start; index < end; index++) {
                    rangeSamples += values[index] > 0 ? 1 : 0;
                }
            }

            this.rangeSamples = rangeSamples;
        }
    }

    // Per-sample metrics of covered events: whole parts from aggregated keys, partial parts and boundary
    // cuts per event; the same integer sums as the event pass
    #computeMetricsFromRecords() {
        const aggregate = this.#aggregate!;
        const { sampleAccepts, classAccepts, accepts } = this.#acceptance!;
        const { keySamples, keyClasses } = aggregate.records;
        const { weights, counts } = aggregate;
        const { samples: baseSamples, values } = this.population;
        const sinkId = this.sinkId;
        const totals = new Float64Array(sinkId + 1);
        const totalCounts = new Float64Array(sinkId + 1);

        for (let key = 0; key < keySamples.length; key++) {
            const sampleId = keySamples[key];
            const target = sampleAccepts[sampleId] === 1 && classAccepts[keyClasses[key]] === 1 ? sampleId : sinkId;

            totals[target] += weights[key];
            totalCounts[target] += counts[key];
        }

        for (const [start, end] of aggregate.partialIntervals) {
            for (let index = start; index < end; index++) {
                const value = values[index];

                if (value !== 0) {
                    const sampleId = baseSamples[index];
                    const target = accepts(index, sampleId) ? sampleId : sinkId;

                    totals[target] += value;
                    totalCounts[target]++;
                }
            }
        }

        for (const { index, value } of this.#boundaryCuts) {
            const sampleId = baseSamples[index];
            const target = accepts(index, sampleId) ? sampleId : sinkId;

            totals[target] -= value;

            if (value === values[index]) {
                totalCounts[target]--;
            }
        }

        this.#totals.set(totals);
        this.#counts.set(totalCounts);
    }

    get ranges() {
        return this.#effectiveRanges;
    }

    get requestedRanges() {
        return this.#ranges;
    }

    // Legacy bounds describe the envelope only. Computation always uses the complete interval set.
    get rangeStart() {
        return this.ranges === null ? null : this.ranges[0]?.start ?? 0;
    }

    get rangeEnd() {
        return this.ranges === null ? null : this.ranges[this.ranges.length - 1]?.end ?? 0;
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
        this.#effectiveRanges = intersectRangeSets(this.source.ranges, next);
        this.#updateValues();
        this.#recompute();
        this.notify();
    }

    #compileValues() {
        this.#boundaryCuts.length = 0;

        if (this.ranges && this.ranges.length > 1) {
            this.#compileMultipleRanges(this.ranges);
            return;
        }

        // Range changes affect weights only; compiled sample destinations and attribute acceptance are reused.
        const originalValues = this.source.values;
        const values = this.buffer.values;
        const { cumulative, rangeStart, rangeEnd } = this;
        let rangeSamples = 0;

        if (rangeStart === null || rangeEnd === null) {
            values.set(originalValues);
            this.rangeSamples = null;
            return;
        }

        if (rangeStart === rangeEnd) {
            values.fill(0);
            this.rangeSamples = 0;
            return;
        }

        // Zero-sized events repeat coordinates: start uses upper_bound - 1, end uses lower_bound for [start, end).
        const first = Math.max(0, findCumulativeBoundary(cumulative, rangeStart, true) - 1);
        const last = findCumulativeBoundary(cumulative, rangeEnd, false);

        // Clear outside in bulk; interior events need no per-event overlap calculation.
        values.fill(0, 0, first);
        values.fill(0, last);

        for (let index = first; index < last; index++) {
            const originalValue = originalValues[index];

            // Count coordinate participation before mask filtering and fractional-weight truncation.
            if (originalValue > 0) {
                rangeSamples++;
            }

            values[index] = originalValue;
        }

        // Keep admitted edge weights whole; patch aggregates after accumulation. A single-event range is
        // clipped once from its full weight, never by subtracting from an already truncated Uint32 value.
        if (first < last) {
            if (values[first] !== 0) {
                this.#addBoundaryCut(first, Math.min(cumulative[first] + originalValues[first], rangeEnd) - Math.max(cumulative[first], rangeStart));
            }

            if (last - 1 !== first && values[last - 1] !== 0) {
                this.#addBoundaryCut(last - 1, rangeEnd - cumulative[last - 1]);
            }
        }

        this.rangeSamples = rangeSamples;
    }

    #compileMultipleRanges(ranges: RangeSet) {
        const values = this.buffer.values;
        const { cumulative } = this;
        const originalValues = this.source.values;
        let clearedEnd = 0;
        let boundaryIndex = -1;
        let boundaryValue = 0;
        let rangeSamples = 0;

        // Called only at interval edges, never from the event loop. Successive intervals can touch the same event;
        // keep its sum in Number until recording the cut so fractional contributions survive truncation.
        const addBoundary = (index: number, contribution: number) => {
            const originalValue = originalValues[index];

            if (index !== boundaryIndex) {
                if (boundaryIndex !== -1) {
                    this.#addBoundaryCut(boundaryIndex, boundaryValue);
                }

                boundaryIndex = index;
                boundaryValue = 0;
                rangeSamples += originalValue > 0 ? 1 : 0;
            }

            boundaryValue += contribution;
            values[index] = originalValue;
        };

        // Normalized ranges are ordered and disjoint. Seek each interval; do not scan events in the gaps.
        // Upper/lower bounds skip zero-sized edge events while preserving zeros inside the interval.
        for (const { start, end } of ranges) {
            const first = Math.max(0, findCumulativeBoundary(cumulative, start, true) - 1);
            const last = findCumulativeBoundary(cumulative, end, false) - 1;

            // When this interval shares the previous edge event, first < clearedEnd and fill is a no-op.
            values.fill(0, clearedEnd, first);
            clearedEnd = last + 1;

            addBoundary(first, Math.min(cumulative[first] + originalValues[first], end) - start);

            for (let index = first + 1; index < last; index++) {
                const originalValue = originalValues[index];

                // All nonzero interior events are wholly covered.
                rangeSamples += originalValue > 0 ? 1 : 0;
                values[index] = originalValue;
            }

            if (last !== first) {
                addBoundary(last, end - cumulative[last]);
            }
        }

        if (boundaryIndex !== -1) {
            this.#addBoundaryCut(boundaryIndex, boundaryValue);
        }

        values.fill(0, clearedEnd);
        this.rangeSamples = rangeSamples;
    }

    #addBoundaryCut(index: number, contribution: number) {
        const value = this.buffer.values[index];

        if (value > 0) {
            const cut = value - Math.min(value, Math.max(0, Math.trunc(contribution)));

            if (cut > 0) {
                this.#boundaryCuts.push({ index, value: cut });
            }
        }
    }
}

export type EventReader = {
    destination: (index: number) => number;
    value: (index: number) => number;
};
type RecordsTables = {
    masks: Uint32Array[];
    events: EventAcceptance[];
};
type RecordsAcceptance = {
    sampleAccepts: Uint8Array;
    classAccepts: Uint8Array;
    accepts: (index: number, sampleId: number) => boolean;
};

// Event intervals whose values ranges keep, and boundary cuts of their edge events: the same coverage as
// PopulationFiltered#compileValues
function computeCoverage(ranges: RangeSet | null, cumulative: Float64Array, values: Uint32Array) {
    const coverage: [number, number][] = [];
    const cuts: { index: number; value: number }[] = [];
    const addCut = (index: number, contribution: number) => {
        const value = values[index];

        if (value > 0) {
            const cut = value - Math.min(value, Math.max(0, Math.trunc(contribution)));

            if (cut > 0) {
                cuts.push({ index, value: cut });
            }
        }
    };

    if (ranges === null) {
        coverage.push([0, values.length]);
    } else if (ranges.length === 1) {
        const [{ start, end }] = ranges;

        if (start !== end) {
            const first = Math.max(0, findCumulativeBoundary(cumulative, start, true) - 1);
            const last = findCumulativeBoundary(cumulative, end, false);

            if (first < last) {
                coverage.push([first, last]);
                addCut(first, Math.min(cumulative[first] + values[first], end) - Math.max(cumulative[first], start));

                if (last - 1 !== first) {
                    addCut(last - 1, end - cumulative[last - 1]);
                }
            }
        }
    } else if (ranges.length > 1) {
        // Successive intervals can touch the same event; sum its contributions before cutting
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

        for (const { start, end } of ranges) {
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

function aggregatePopulation(population: Population | PopulationFiltered, groups: Uint8Array | Uint32Array, groupCount: number) {
    const { samples, values, sinkId, cumulative, ranges } = population;
    const samplesCount = new Uint32Array(groupCount);
    const samplesTotal = new Float64Array(groupCount);

    if (ranges === null) {
        aggregateRange(samples, values, groups, sinkId, samplesCount, samplesTotal, 0, values.length);
    } else {
        let end = 0;

        for (const range of ranges) {
            const start = Math.max(end, findCumulativeBoundary(cumulative, range.start, true) - 1);

            end = findCumulativeBoundary(cumulative, range.end, false);
            aggregateRange(samples, values, groups, sinkId, samplesCount, samplesTotal, start, end);
        }
    }

    return { samplesCount, samplesTotal };
}

function createComputeBuffer(eventCount: number, sampleCount: number, useWasm = true) {
    const aggregateSize = sampleCount + 1;
    // Float64 totals go first to keep their 8-byte alignment
    const byteSize =
        8 * aggregateSize + // samplesTotal
        4 * eventCount +    // values
        4 * eventCount +    // samples
        4 * aggregateSize;  // samplesCount
    const memory = useWasm
        ? new WebAssembly.Memory({ initial: Math.ceil(byteSize / 0x10000) })
        : new Uint8Array(byteSize);
    const bufferMap: PopulationBufferMap = {
        memory,
        samplesTotal: new Float64Array(memory.buffer, 0, aggregateSize),
        values: new Uint32Array(memory.buffer, 8 * aggregateSize, eventCount),
        samples: new Uint32Array(memory.buffer, 8 * aggregateSize + 4 * eventCount, eventCount),
        samplesCount: new Uint32Array(memory.buffer, 8 * aggregateSize + 8 * eventCount, aggregateSize)
    };

    return bufferMap;
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

function computeCumulative(values: Uint32Array) {
    const cumulative = new Float64Array(values.length);

    for (let index = 1; index < values.length; index++) {
        cumulative[index] = cumulative[index - 1] + values[index - 1];
    }

    return cumulative;
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

function isMaskEmpty(mask: Uint32Array) {
    for (let i = 0; i < mask.length; i++) {
        if (mask[i] !== 0) {
            return false;
        }
    }

    return true;
}
