import { createComputeBuffer, wasmBacked, type WasmExports } from './compute-wasm.js';
import populationWasm from './population.compute.wasm';

// Event-sized vectors of the event pass and per-sample aggregates, the sink included
export function createPopulationBuffer(eventCount: number, sampleCount: number) {
    const aggregateSize = sampleCount + 1;

    return createComputeBuffer({
        samplesTotal: [Float64Array, aggregateSize],
        values: [Uint32Array, eventCount],
        samples: [Uint32Array, eventCount],
        samplesCount: [Uint32Array, aggregateSize]
    });
}

export type PopulationBuffer = ReturnType<typeof createPopulationBuffer>;
export type PopulationApi = typeof populationJavaScriptApi;

// The event pass (population.compute.wat): events of nonzero values add their counts and values to their samples
// or the sink
const populationJavaScriptApi = {
    accumulateSampleMetrics(buffer: PopulationBuffer) {
        const {
            values,
            samples,
            samplesCount,
            samplesTotal
        } = buffer;

        for (let i = values.length - 1; i >= 0; i--) {
            const value = values[i];

            if (value !== 0) {
                samplesCount[samples[i]] += 1;
                samplesTotal[samples[i]] += value;
            }
        }
    }
};
export const populationApiOf = wasmBacked(populationWasm, populationJavaScriptApi, bindPopulationWasm);

function bindPopulationWasm(wasm: WasmExports<'accumulateSampleMetrics'>): PopulationApi {
    return {
        accumulateSampleMetrics(buffer) {
            wasm.accumulateSampleMetrics(
                buffer.values.length,
                buffer.values.byteOffset,
                buffer.samples.byteOffset,
                buffer.samplesCount.byteOffset,
                buffer.samplesTotal.byteOffset,
                buffer.samplesTotal.length
            );
        }
    };
}
