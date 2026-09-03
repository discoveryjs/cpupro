import { USE_WASM } from '../const.js';
import { Observer, binarySearch } from './misc.js';
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
    samples: Uint32Array;
    values: Uint32Array;
    cumulative: Uint32Array;   // size of values
    samplesCount: Uint32Array; // size of samples
    samplesTotal: Uint32Array; // size of samples
    samplesMask: Uint32Array;
    rangeStart: number | null = null;
    rangeEnd: number | null = null;
    rangeSamples: number | null = null;

    constructor(population: Population) {
        super();

        this.population = population;
        this.buffer = createComputeBuffer(population.samples, population.values, USE_WASM);
        this.samples = this.buffer.samples;
        this.values = this.buffer.values;
        this.cumulative = population.cumulative;
        this.samplesCount = this.buffer.samplesCount;
        this.samplesTotal = this.buffer.samplesTotal;
        this.samplesMask = new Uint32Array(this.samples.length);

        const api = USE_WASM && this.buffer.memory
            ? createWasmApi(this.buffer.memory)
            : computeMetricsJavaScriptApi;
        this.#recompute = api.computeMetrics.bind(null, this.buffer);
        this.#recompute(false);
    }

    resetMask() {
        this.samplesMask.fill(0);

        if (this.samples !== this.population.samples) {
            this.samples = this.population.samples;
            this.notify();
        }
    }

    hasMask() {
        return this.samples !== this.population.samples;
    }

    // FIXME: the logic is incomplete and incorrect
    updateMask(maskFn: MaskFunction) {
        const originalSamples = this.population.samples;
        const hasMaskedSamples = this.samples !== originalSamples;

        maskFn(this.samplesMask);

        // mask is empty and no samples are masked, no need to update
        if (isMaskEmpty(this.samplesMask) && !hasMaskedSamples) {
            return;
        }

        const samples = this.samples;
        for (let i = 0; i < samples.length; i++) {
            samples[i] = this.samplesMask[i] === 0
                ? originalSamples[i]
                : 0;
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
        this.rangeSamples = null;
        this.values.set(this.population.values);

        this.#recompute();
        this.notify();
    }

    setRange(start: number | null, end: number | null) {
        if (start === null || end === null) {
            this.resetRange();
            return;
        }

        const { values, cumulative } = this;
        const originalValues = this.population.values;
        const startIndex = binarySearch(cumulative, start);
        const endIndex = binarySearch(cumulative, end);

        this.rangeStart = start;
        this.rangeEnd = end;
        this.rangeSamples = endIndex - startIndex + 1;

        values.fill(0);

        if (startIndex !== endIndex) {
            values[startIndex] = originalValues[startIndex] - (start - cumulative[startIndex]);
            values[endIndex] = end - cumulative[endIndex];

            if (startIndex + 1 < endIndex) {
                values.set(originalValues.subarray(startIndex + 1, endIndex), startIndex + 1);
            }
        } else {
            values[startIndex] = end - start;
        }

        this.#recompute();
        this.notify();
    }
}

function createComputeBuffer(
    samples: Uint32Array,
    values: Uint32Array,
    useWasm = true
) {
    // estimate buffer size
    const samplesMaxId = findMaxId(samples) + 1;
    const bufferSize =
        values.length + // values
        samples.length + // samples
        // samplesCount
        // samplesTotal
        2 * samplesMaxId;

    const memory = useWasm
        ? new WebAssembly.Memory({ initial: Math.ceil(4 * bufferSize / 0xffff) })
        : new Uint8Array(4 * bufferSize);
    const buffer = new Uint32Array(memory.buffer);
    let bufferOffset = 0;
    const bufferMap: PopulationBufferMap = {
        memory,
        values: adopt(values),
        samples: adopt(samples),
        samplesCount: alloc(samplesMaxId),
        samplesTotal: alloc(samplesMaxId)
    };

    return bufferMap;

    function adopt(array: Uint32Array) {
        buffer.set(array, bufferOffset);

        return buffer.subarray(bufferOffset, bufferOffset += array.length);
    }

    function alloc(size: number) {
        return buffer.subarray(bufferOffset, bufferOffset += size);
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
