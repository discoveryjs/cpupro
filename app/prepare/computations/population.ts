import { USE_WASM } from '../const.js';
import { Observer } from './misc.js';
import { PopulationBufferMap, createJavaScriptApi, createWasmApi } from './compute-wasm-wrapper.js';
import { PopulationFilter } from './population-filter.js';
import type { Acceptance } from './attribute-filter.js';
import { normalizeRanges, intersectRanges, equalRanges, validateRangeBounds, type RangeSet } from './coordinates.js';

const computeMetricsJavaScriptApi = createJavaScriptApi();

export class Population extends Observer {
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
        values: Uint32Array
    ) {
        super();

        this.samples = samples;
        this.values = values;
        this.cumulative = computeCumulative(values);
        this.cumulativeEnd = values.length ? this.cumulative[values.length - 1] + values[values.length - 1] : 0;

        const maxSampleId = findMaxId(samples) + 1;
        this.samplesCount = new Uint32Array(maxSampleId);
        this.samplesTotal = new Uint32Array(maxSampleId);

        computeMetricsJavaScriptApi.computeMetrics({
            memory: null,
            values: this.values,
            samples: this.samples,
            samplesCount: this.samplesCount,
            samplesTotal: this.samplesTotal
        }, false);
    }
}

export type MaskFunction = (mask: Uint32Array) => void;
export class PopulationFiltered extends Observer {
    population: Population;
    filter: PopulationFilter;
    declare readonly sink: { count: number; total: number };
    buffer: PopulationBufferMap;
    #recompute: (clear?: boolean) => void;
    #hasMask = false;
    #acceptsEvent: Acceptance | null = null;
    samples: Uint32Array;
    values: Uint32Array;
    cumulative: Uint32Array;   // size of values
    samplesCount: Uint32Array; // size of samples
    // FIXME: Filtered totals share the same Uint32 overflow limit, including the buffer's sink cell.
    samplesTotal: Uint32Array; // size of samples
    samplesMask: Uint32Array;
    #ranges: RangeSet | null = null;
    rangeSamples: number | null = null;
    indexStart: number | null = null;
    indexEnd: number | null = null;
    valueMin: number | null = null;
    valueMax: number | null = null;

    constructor(population: Population) {
        super();

        this.population = population;
        this.buffer = createComputeBuffer(population, USE_WASM);
        this.samples = this.buffer.samples;
        this.values = this.buffer.values;
        this.cumulative = population.cumulative;
        this.samplesCount = this.buffer.samplesCount.subarray(0, population.samplesCount.length);
        this.samplesTotal = this.buffer.samplesTotal.subarray(0, population.samplesTotal.length);
        this.samplesMask = new Uint32Array(population.samplesCount.length);

        const api = USE_WASM && this.buffer.memory
            ? createWasmApi(this.buffer.memory)
            : computeMetricsJavaScriptApi;
        this.#recompute = api.computeMetrics.bind(null, this.buffer);
        this.filter = new PopulationFilter(
            population.samplesCount.length,
            population.samples.length,
            (updateMask, acceptsEvent) => {
                this.#acceptsEvent = acceptsEvent;
                this.updateMask(updateMask);
            }
        );

        Object.defineProperty(this, 'sink', {
            get: () => this.#sink
        });
    }

    get sinkId() {
        return this.samplesCount.length;
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
        const originalSamples = this.population.samples;
        const hadMask = this.#hasMask;

        maskFn(this.samplesMask);
        this.#hasMask = this.#acceptsEvent !== null || !isMaskEmpty(this.samplesMask);

        if (!this.#hasMask && !hadMask) {
            return;
        }

        const samples = this.samples;
        const sinkId = this.sinkId;
        let changed = false;

        for (let i = 0; i < samples.length; i++) {
            const sampleId = originalSamples[i];
            const target = this.samplesMask[sampleId] === 0 && (!this.#acceptsEvent || this.#acceptsEvent(i)) ? sampleId : sinkId;

            changed = changed || samples[i] !== target;
            samples[i] = target;
        }

        if (!changed) {
            return;
        }

        this.#recompute();
        this.notify();
    }

    get ranges() {
        return this.#ranges;
    }

    // Legacy bounds describe the envelope only. Computation always uses the complete interval set.
    get rangeStart() {
        return this.#ranges === null ? null : this.#ranges[0]?.start ?? 0;
    }

    get rangeEnd() {
        return this.#ranges === null ? null : this.#ranges[this.#ranges.length - 1]?.end ?? 0;
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
        if (this.#ranges && this.#ranges.length > 1) {
            this.#compileMultipleRanges(this.#ranges);
            return;
        }

        // Range changes affect weights only; compiled sample destinations and attribute acceptance are reused.
        const originalValues = this.population.values;
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

        // Test original weights first, then clip only admitted edges. A single-event range must be clipped once,
        // from the original weight, not by sequential subtraction from an already truncated Uint32 value.
        if (hasRange && first < last) {
            if (values[first] !== 0) {
                values[first] = Math.min(cumulative[first] + originalValues[first], rangeEnd) - Math.max(cumulative[first], rangeStart);
            }

            if (last - 1 !== first && values[last - 1] !== 0) {
                values[last - 1] = rangeEnd - cumulative[last - 1];
            }
        }

        this.rangeSamples = hasRange ? rangeSamples : null;
    }

    #compileMultipleRanges(ranges: RangeSet) {
        const { values, cumulative } = this;
        const originalValues = this.population.values;
        const indexStart = this.indexStart ?? 0;
        const indexEnd = this.indexEnd ?? values.length;
        const min = this.valueMin ?? -Infinity;
        const max = this.valueMax ?? Infinity;
        let clearedEnd = 0;
        let boundaryIndex = -1;
        let boundaryValue = 0;
        let rangeSamples = 0;

        // Called only at interval edges, never from the event loop. Successive intervals can touch the same event;
        // keep its sum in Number across writes so fractional contributions survive Uint32 truncation.
        const addBoundary = (index: number, contribution: number) => {
            const originalValue = originalValues[index];

            if (index !== boundaryIndex) {
                boundaryIndex = index;
                boundaryValue = 0;
                rangeSamples++;
            }

            boundaryValue += contribution;
            values[index] = index >= indexStart && index < indexEnd && originalValue >= min && originalValue < max
                ? boundaryValue : 0;
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

        values.fill(0, clearedEnd);
        this.rangeSamples = rangeSamples;
    }
}

function createComputeBuffer(
    population: Population,
    useWasm = true
) {
    const { samples, values, samplesCount, samplesTotal } = population;
    // estimate buffer size
    let bufferOffset = 0;
    const bufferSize =
        values.length + // values
        samples.length + // samples
        samplesCount.length + 1 +
        samplesTotal.length + 1;

    const memory = useWasm
        ? new WebAssembly.Memory({ initial: Math.ceil(4 * bufferSize / 0xffff) })
        : new Uint8Array(4 * bufferSize);
    const buffer = new Uint32Array(memory.buffer);
    const bufferMap: PopulationBufferMap = {
        memory,
        values: adopt(values),
        samples: adopt(samples),
        samplesCount: adopt(samplesCount, 1),
        samplesTotal: adopt(samplesTotal, 1)
    };

    return bufferMap;

    function adopt(array: Uint32Array, extraLength = 0) {
        buffer.set(array, bufferOffset);

        return buffer.subarray(bufferOffset, bufferOffset += array.length + extraLength);
    }

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
