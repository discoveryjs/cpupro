import { USE_WASM } from '../const.js';
import { Observer } from './misc.js';
import { PopulationBufferMap, createJavaScriptApi, createWasmApi } from './compute-wasm-wrapper.js';

const computeMetricsJavaScriptApi = createJavaScriptApi();

export class Population extends Observer {
    samples: Uint32Array;
    values: Uint32Array;
    cumulative: Uint32Array;   // size of values
    samplesCount: Uint32Array; // size of samples
    samplesTotal: Uint32Array; // size of samples

    constructor(
        samples: Uint32Array,
        values: Uint32Array
    ) {
        super();

        this.samples = samples;
        this.values = values;
        this.cumulative = computeCumulative(this.values);

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
    buffer: PopulationBufferMap;
    #recompute: (clear?: boolean) => void;
    #hasMask = false;
    samples: Uint32Array;
    values: Uint32Array;
    cumulative: Uint32Array;   // size of values
    samplesCount: Uint32Array; // size of samples
    samplesTotal: Uint32Array; // size of samples
    samplesMask: Uint32Array;
    rangeStart: number | null = null;
    rangeEnd: number | null = null;
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
    }

    get sinkId() {
        return this.samplesCount.length;
    }

    get sink() {
        return {
            count: this.buffer.samplesCount[this.sinkId],
            total: this.buffer.samplesTotal[this.sinkId]
        };
    }

    resetMask() {
        if (!this.#hasMask) {
            return;
        }

        this.samplesMask.fill(0);
        this.#hasMask = false;
        this.samples.set(this.population.samples);
        this.#recompute();
        this.notify();
    }

    hasMask() {
        return this.#hasMask;
    }

    updateMask(maskFn: MaskFunction) {
        const originalSamples = this.population.samples;
        const hadMask = this.#hasMask;

        maskFn(this.samplesMask);
        this.#hasMask = !isMaskEmpty(this.samplesMask);

        if (!this.#hasMask && !hadMask) {
            return;
        }

        const samples = this.samples;
        const sinkId = this.sinkId;
        let changed = false;
        for (let i = 0; i < samples.length; i++) {
            const sampleId = originalSamples[i];
            const target = this.samplesMask[sampleId] === 0 ? sampleId : sinkId;
            changed = changed || samples[i] !== target;
            samples[i] = target;
        }

        if (!changed) {
            return;
        }

        this.#recompute();
        this.notify();
    }

    resetRange() {
        if (this.rangeStart === null && this.rangeEnd === null) {
            return;
        }

        this.rangeStart = null;
        this.rangeEnd = null;
        this.#compileValues();
        this.#recompute();
        this.notify();
    }

    setRange(start: number | null, end: number | null) {
        if (start === null || end === null) {
            this.resetRange();
            return;
        }

        validateRange(start, end);
        const length = this.population.values.length;
        const total = length === 0 ? 0 : this.cumulative[length - 1] + this.population.values[length - 1];
        start = Math.max(0, Math.min(total, start));
        end = Math.max(0, Math.min(total, end));

        if (this.rangeStart === start && this.rangeEnd === end) {
            return;
        }

        this.rangeStart = start;
        this.rangeEnd = end;
        this.#compileValues();
        this.#recompute();
        this.notify();
    }

    setIndexRange(start: number | null, end: number | null) {
        validateRange(start, end);
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
        validateRange(min, max);
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
        const originalValues = this.population.values;
        const { values, cumulative, rangeStart, rangeEnd } = this;
        const indexStart = this.indexStart ?? 0;
        const indexEnd = this.indexEnd ?? values.length;
        const min = this.valueMin ?? -Infinity;
        const max = this.valueMax ?? Infinity;
        const hasRange = rangeStart !== null && rangeEnd !== null;
        let rangeSamples = 0;

        for (let index = 0; index < values.length; index++) {
            const originalValue = originalValues[index];
            const contribution = hasRange
                ? Math.max(0, Math.min(cumulative[index] + originalValue, rangeEnd) - Math.max(cumulative[index], rangeStart))
                : originalValue;

            if (contribution > 0) {
                rangeSamples++;
            }
            values[index] = index >= indexStart && index < indexEnd && originalValue >= min && originalValue < max
                ? contribution
                : 0;
        }

        this.rangeSamples = hasRange ? rangeSamples : null;
    }
}

function validateRange(start: number | null, end: number | null) {
    if ((start !== null && !Number.isFinite(start)) ||
        (end !== null && !Number.isFinite(end)) ||
        (start !== null && end !== null && start > end)) {
        throw new RangeError('Range boundaries must be finite and ordered');
    }
}

function createComputeBuffer(
    population: Population,
    useWasm = true
) {
    const { samples, values, samplesCount, samplesTotal } = population;
    // estimate buffer size
    const bufferSize =
        values.length + // values
        samples.length + // samples
        samplesCount.length + 1 +
        samplesTotal.length + 1;

    const memory = useWasm
        ? new WebAssembly.Memory({ initial: Math.ceil(4 * bufferSize / 0xffff) })
        : new Uint8Array(4 * bufferSize);
    const buffer = new Uint32Array(memory.buffer);
    let bufferOffset = 0;
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
    const cumulative = new Uint32Array(values.length);

    for (let i = 1; i < cumulative.length; i++) {
        cumulative[i] = values[i - 1] + cumulative[i - 1];
    }

    return cumulative;
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
