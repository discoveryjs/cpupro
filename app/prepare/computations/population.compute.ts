import { createComputeScratch, wasmBacked, type WasmExports } from './compute-wasm.js';
import populationWasm from './population.compute.wasm';

// PERF: Events are staged in chunks, so the scratch buffer stays small for any number of events
const PASS_CHUNK_SIZE = 1 << 16;

const layoutScratch = createComputeScratch();

// The event pass (population.compute.wat) over destinations and values of events: events of nonzero values add their
// counts and values to their samples or the sink, samplesCount and samplesTotal of the samples and the sink
export function accumulateSampleMetrics(
    samples: Uint32Array,
    values: Uint32Array,
    samplesCount: Uint32Array,
    samplesTotal: Float64Array
) {
    const chunkSize = Math.min(values.length, PASS_CHUNK_SIZE);
    const buffer = layoutPassBuffer(samplesTotal.length, chunkSize);
    const api = populationApiOf(buffer);

    buffer.samplesTotal.set(samplesTotal);
    buffer.samplesCount.set(samplesCount);
    api.integerTotals(buffer);

    for (let start = 0; start < values.length; start += chunkSize) {
        const end = Math.min(values.length, start + chunkSize);

        buffer.values.set(values.subarray(start, end));
        buffer.samples.set(samples.subarray(start, end));
        api.accumulateSampleMetrics(buffer, end - start);
    }

    api.floatTotals(buffer);
    samplesTotal.set(buffer.samplesTotal);
    samplesCount.set(buffer.samplesCount);
}

// Per-sample aggregates, the sink included, and a chunk of events
function layoutPassBuffer(aggregateSize: number, chunkSize: number) {
    return layoutScratch({
        samplesTotal: [Float64Array, aggregateSize],
        samplesCount: [Uint32Array, aggregateSize],
        values: [Uint32Array, chunkSize],
        samples: [Uint32Array, chunkSize]
    });
}

type PopulationBuffer = ReturnType<typeof layoutPassBuffer>;
type PopulationApi = {
    integerTotals(buffer: PopulationBuffer): void;
    floatTotals(buffer: PopulationBuffer): void;
    accumulateSampleMetrics(buffer: PopulationBuffer, size: number): void;
};

// Passes of population.compute.wat over the pass buffer; the twin sums totals as floats, exact for sums of
// integers below 2^53, so its totals need no conversions
const populationJavaScriptApi: PopulationApi = {
    integerTotals() {},
    floatTotals() {},
    accumulateSampleMetrics(buffer, size) {
        const {
            values,
            samples,
            samplesCount,
            samplesTotal
        } = buffer;

        for (let i = size - 1; i >= 0; i--) {
            const value = values[i];

            if (value !== 0) {
                samplesCount[samples[i]] += 1;
                samplesTotal[samples[i]] += value;
            }
        }
    }
};
const populationApiOf = wasmBacked(populationWasm, populationJavaScriptApi, bindPopulationWasm);

function bindPopulationWasm(
    wasm: WasmExports<'integerTotals' | 'floatTotals' | 'accumulateSampleMetrics'>
): PopulationApi {
    return {
        integerTotals(buffer) {
            wasm.integerTotals(buffer.samplesTotal.byteOffset, buffer.samplesTotal.length);
        },
        floatTotals(buffer) {
            wasm.floatTotals(buffer.samplesTotal.byteOffset, buffer.samplesTotal.length);
        },
        accumulateSampleMetrics(buffer, size) {
            wasm.accumulateSampleMetrics(
                size,
                buffer.values.byteOffset,
                buffer.samples.byteOffset,
                buffer.samplesCount.byteOffset,
                buffer.samplesTotal.byteOffset
            );
        }
    };
}
