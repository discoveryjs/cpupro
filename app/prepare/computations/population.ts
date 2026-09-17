import { USE_WASM } from '../const.js';
import { Observer } from './misc.js';
import { PopulationBufferMap, createJavaScriptApi, createWasmApi } from './compute-wasm-wrapper.js';
import { PopulationFilter } from './population-filter.js';
import type { Acceptance } from './attribute-filter.js';
import { normalizeRanges, intersectRanges, equalRanges, validateRangeBounds, type RangeSet } from './coordinates.js';

const computeMetricsJavaScriptApi = createJavaScriptApi();

export class Population extends Observer {
    readonly ranges: RangeSet | null = null;
    readonly sinkId: number;
    readonly sink: { count: number; total: number };
    readonly samplesRevision = 0;
    samples: Uint32Array;
    values: Uint32Array;
    // FIXME: Prefix sums wrap at 2^32, breaking coordinate order and binary range search.
    cumulative: Uint32Array;   // size of values
    // End of the base cumulative axis, not the sum of filtered contributions. Shares the overflow limitation above.
    readonly cumulativeEnd: number;
    samplesCount: Uint32Array; // size of samples
    // FIXME: Per-sample totals also wrap at 2^32. Widen storage and JS/WASM accumulation together;
    // changing cumulative alone does not resolve overflow. This is deferred beyond the range optimization.
    samplesTotal: Uint32Array; // size of samples

    constructor(
        samples: Uint32Array,
        values: Uint32Array,
        sampleCount = findMaxId(samples) + 1
    ) {
        super();

        this.samples = samples;
        this.values = values;
        this.cumulative = computeCumulative(values);
        this.cumulativeEnd = values.length ? this.cumulative[values.length - 1] + values[values.length - 1] : 0;
        this.sinkId = sampleCount;

        const samplesCount = new Uint32Array(sampleCount + 1);
        const samplesTotal = new Uint32Array(sampleCount + 1);
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
}

export type MaskFunction = (mask: Uint32Array) => void;
export class PopulationFiltered extends Observer {
    population: Population;
    readonly source: Population | PopulationFiltered;
    filter: PopulationFilter;
    readonly sink: { count: number; total: number };
    buffer: PopulationBufferMap;
    #recompute: (clear?: boolean) => void;
    #hasMask = false;
    #acceptsEvent: Acceptance | null = null;
    #unsubscribe: () => void;
    #boundaryCuts: { index: number; value: number }[] = [];
    samplesRevision = 0;
    samples: Uint32Array;
    values: Uint32Array;
    cumulative: Uint32Array;   // size of values
    samplesCount: Uint32Array; // size of samples
    // FIXME: Filtered totals share the same Uint32 overflow limit, including the buffer's sink cell.
    samplesTotal: Uint32Array; // size of samples
    samplesMask: Uint32Array;
    #ranges: RangeSet | null = null;
    #effectiveRanges: RangeSet | null = null;
    rangeSamples: number | null = null;
    indexStart: number | null = null;
    indexEnd: number | null = null;
    valueMin: number | null = null;
    valueMax: number | null = null;

    constructor(source: Population | PopulationFiltered) {
        super();

        const sampleCount = source.samplesCount.length;
        this.source = source;
        this.population = source instanceof PopulationFiltered ? source.population : source;
        this.buffer = createComputeBuffer(source, USE_WASM);
        this.samples = this.buffer.samples;
        this.values = this.buffer.values;
        this.cumulative = source.cumulative;
        this.samplesCount = this.buffer.samplesCount.subarray(0, sampleCount);
        this.samplesTotal = this.buffer.samplesTotal.subarray(0, sampleCount);
        this.samplesMask = new Uint32Array(sampleCount);

        const api = USE_WASM && this.buffer.memory
            ? createWasmApi(this.buffer.memory)
            : computeMetricsJavaScriptApi;
        this.#recompute = (clear = true) => {
            api.computeMetrics(this.buffer, clear);
            for (const { index, value } of this.#boundaryCuts) {
                const sampleId = this.samples[index];
                this.buffer.samplesTotal[sampleId] -= value;
                if (value === this.values[index]) {
                    this.buffer.samplesCount[sampleId]--;
                }
            }
        };
        this.filter = new PopulationFilter(
            sampleCount,
            source.samples.length,
            (updateMask, acceptsEvent) => {
                this.#acceptsEvent = acceptsEvent;
                this.updateMask(updateMask);
            }
        );

        Object.defineProperty(this, 'sink', {
            get: () => this.#sink
        });

        this.#effectiveRanges = source.ranges;
        this.#compileValues();
        this.#recompute();
        let samplesRevision = source.samplesRevision;
        this.#unsubscribe = source.subscribe(() => {
            if (samplesRevision !== source.samplesRevision) {
                samplesRevision = source.samplesRevision;
                this.#compileSamples();
            }

            this.#effectiveRanges = intersectRangeSets(source.ranges, this.#ranges);
            this.#compileValues();
            this.#recompute();
            this.notify();
        });
    }

    destroy() {
        this.#unsubscribe();
    }

    get cumulativeEnd(): number {
        return this.population.cumulativeEnd;
    }

    get sinkId() {
        return this.population.sinkId;
    }

    get #sink() {
        return {
            count: this.buffer.samplesCount[this.sinkId],
            total: this.buffer.samplesTotal[this.sinkId]
        };
    }

    resetMask() {
        const { sampleBits } = this.filter;

        this.updateMask(mask => {
            for (let sampleId = 0; sampleId < mask.length; sampleId++) {
                mask[sampleId] &= sampleBits;
            }
        });
    }

    hasMask() {
        return this.#hasMask;
    }

    updateMask(maskFn: MaskFunction) {
        const hadMask = this.#hasMask;

        maskFn(this.samplesMask);
        this.#hasMask = this.#acceptsEvent !== null || !isMaskEmpty(this.samplesMask);

        if (!this.#hasMask && !hadMask) {
            return;
        }

        if (this.#compileSamples()) {
            this.#recompute();
            this.notify();
        }
    }

    #compileSamples() {
        const originalSamples = this.source.samples;
        const samples = this.samples;
        const sinkId = this.sinkId;
        let changed = false;

        for (let i = 0; i < samples.length; i++) {
            const sampleId = originalSamples[i];
            const target = sampleId !== sinkId && this.samplesMask[sampleId] === 0 &&
                (!this.#acceptsEvent || this.#acceptsEvent(i)) ? sampleId : sinkId;

            changed = changed || samples[i] !== target;
            samples[i] = target;
        }

        if (changed) {
            this.samplesRevision++;
        }

        return changed;
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
        this.#compileValues();
        this.#recompute();
        this.notify();
    }

    setIndexRange(start: number | null, end: number | null) {
        validateRangeBounds(start, end);

        if ((start !== null && !Number.isInteger(start)) || (end !== null && !Number.isInteger(end))) {
            throw new RangeError('Index range boundaries must be integers');
        }

        const length = this.population.values.length;

        start = start === null ? null : Math.max(0, Math.min(length, start));
        end = end === null ? null : Math.max(0, Math.min(length, end));

        if (this.indexStart === start && this.indexEnd === end) {
            return;
        }

        this.indexStart = start;
        this.indexEnd = end;
        this.#compileValues();
        this.#recompute();
        this.notify();
    }

    resetIndexRange() {
        this.setIndexRange(null, null);
    }

    setValueRange(min: number | null, max: number | null) {
        validateRangeBounds(min, max);

        if (this.valueMin === min && this.valueMax === max) {
            return;
        }

        this.valueMin = min;
        this.valueMax = max;
        this.#compileValues();
        this.#recompute();
        this.notify();
    }

    resetValueRange() {
        this.setValueRange(null, null);
    }

    #compileValues() {
        this.#boundaryCuts.length = 0;

        if (this.ranges && this.ranges.length > 1) {
            this.#compileMultipleRanges(this.ranges);
            return;
        }

        // Range changes affect weights only; compiled sample destinations and attribute acceptance are reused.
        const originalValues = this.source.values;
        const { values, cumulative, rangeStart, rangeEnd } = this;
        const indexStart = this.indexStart ?? 0;
        const indexEnd = this.indexEnd ?? values.length;
        const min = this.valueMin ?? -Infinity;
        const max = this.valueMax ?? Infinity;
        const hasRange = rangeStart !== null && rangeEnd !== null;
        let rangeSamples = 0;

        if (!hasRange && this.indexStart === null && this.indexEnd === null && this.valueMin === null && this.valueMax === null) {
            values.set(originalValues);
            this.rangeSamples = null;
            return;
        }

        let first = 0;
        let last = values.length;

        if (hasRange) {
            if (rangeStart === rangeEnd) {
                values.fill(0);
                this.rangeSamples = 0;
                return;
            }

            // Zero-sized events repeat coordinates: start uses upper_bound - 1, end uses lower_bound for [start, end).
            first = Math.max(0, findCumulativeBoundary(cumulative, rangeStart, true) - 1);
            last = findCumulativeBoundary(cumulative, rangeEnd, false);
        } else {
            first = indexStart;
            last = Math.max(first, indexEnd);
        }

        // Clear outside in bulk; interior events need no per-event overlap calculation.
        values.fill(0, 0, first);
        values.fill(0, last);

        for (let index = first; index < last; index++) {
            const originalValue = originalValues[index];

            // Count coordinate participation before index/value/mask filtering and fractional-weight truncation.
            if (originalValue > 0) {
                rangeSamples++;
            }

            values[index] = index >= indexStart && index < indexEnd && originalValue >= min && originalValue < max
                ? originalValue
                : 0;
        }

        // Keep admitted edge weights whole; patch aggregates after accumulation. A single-event range is
        // clipped once from its full weight, never by subtracting from an already truncated Uint32 value.
        if (hasRange && first < last) {
            if (values[first] !== 0) {
                this.#addBoundaryCut(first, Math.min(cumulative[first] + originalValues[first], rangeEnd) - Math.max(cumulative[first], rangeStart));
            }

            if (last - 1 !== first && values[last - 1] !== 0) {
                this.#addBoundaryCut(last - 1, rangeEnd - cumulative[last - 1]);
            }
        }

        this.rangeSamples = hasRange ? rangeSamples : null;
    }

    #compileMultipleRanges(ranges: RangeSet) {
        const { values, cumulative } = this;
        const originalValues = this.source.values;
        const indexStart = this.indexStart ?? 0;
        const indexEnd = this.indexEnd ?? values.length;
        const min = this.valueMin ?? -Infinity;
        const max = this.valueMax ?? Infinity;
        let clearedEnd = 0;
        let boundaryIndex = -1;
        let boundaryValue = 0;
        let rangeSamples = 0;

        // Called only at interval edges, never from the event loop. Successive intervals can touch the same event;
        // keep its sum in Number until recording the cut so fractional contributions survive Uint32 truncation.
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
            values[index] = index >= indexStart && index < indexEnd && originalValue >= min && originalValue < max
                ? originalValue : 0;
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

                // Count participation before other constraints; all nonzero interior events are wholly covered.
                rangeSamples += originalValue > 0 ? 1 : 0;
                values[index] = index >= indexStart && index < indexEnd && originalValue >= min && originalValue < max
                    ? originalValue : 0;
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
        const value = this.values[index];

        if (value > 0) {
            const cut = value - Math.min(value, Math.max(0, Math.trunc(contribution)));

            if (cut > 0) {
                this.#boundaryCuts.push({ index, value: cut });
            }
        }
    }
}

function createComputeBuffer(
    population: Population | PopulationFiltered,
    useWasm = true
) {
    const { samples, values, samplesCount } = population;
    const aggregateSize = samplesCount.length + 1;
    // estimate buffer size
    let bufferOffset = 0;
    const bufferSize =
        values.length + // values
        samples.length + // samples
        aggregateSize +
        aggregateSize;

    const memory = useWasm
        ? new WebAssembly.Memory({ initial: Math.ceil(4 * bufferSize / 0xffff) })
        : new Uint8Array(4 * bufferSize);
    const buffer = new Uint32Array(memory.buffer);
    const bufferMap: PopulationBufferMap = {
        memory,
        values: reserve(values.length),
        samples: adopt(samples),
        samplesCount: reserve(aggregateSize),
        samplesTotal: reserve(aggregateSize)
    };

    return bufferMap;

    function adopt(array: Uint32Array) {
        buffer.set(array, bufferOffset);

        return buffer.subarray(bufferOffset, bufferOffset += array.length);
    }

    function reserve(length: number) {
        return buffer.subarray(bufferOffset, bufferOffset += length);
    }
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
    // Binary range search assumes no Uint32 overflow. Widening this vector alone would not fix samplesTotal overflow.
    const cumulative = new Uint32Array(values.length);

    for (let index = 1; index < values.length; index++) {
        cumulative[index] = cumulative[index - 1] + values[index - 1];
    }

    return cumulative;
}

function findCumulativeBoundary(cumulative: Uint32Array, value: number, afterEqual: boolean) {
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
