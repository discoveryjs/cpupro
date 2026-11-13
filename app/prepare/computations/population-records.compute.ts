import { powerOfTwoCapacity } from '../misc/utils.js';
import {
    createComputeBuffer,
    elementMask,
    wasmBacked,
    type VectorConstructor,
    type WasmExports
} from './compute-wasm.js';
import type { EventClasses } from './population-filter.js';
import recordsWasm from './population-records.compute.wasm';

type ClassIds = EventClasses['ids'];

// A buffer for parts of up to a number of events: the staged events of a part, the tables finding records (slots of
// a hash table at most half occupied, records by class within runs of one sample) and the records of the part, at most
// one per event. Classes are staged in the element type of the population's classes
export function createRecordsBuffer(partSize: number, classCount: number, classIds: ClassIds) {
    const buffer = createComputeBuffer({
        recordWeights: [Float64Array, partSize], // per record: sum of event values
        samples: [Uint32Array, partSize],
        values: [Uint32Array, partSize],
        classes: [classIds.constructor as VectorConstructor<ClassIds>, partSize],
        slots: [Int32Array, powerOfTwoCapacity(2 * partSize)],
        classRecords: [Int32Array, classCount],
        recordSamples: [Uint32Array, partSize],
        recordClasses: [Uint32Array, partSize],
        recordCounts: [Uint32Array, partSize], // per record: number of events with a nonzero value
        runs: [Uint32Array, 1],                // number of runs of one sample in the part
        nonzero: [Uint32Array, 1]              // number of events of the part with a nonzero value
    });

    buffer.slots.fill(-1);
    buffer.classRecords.fill(-1);

    return buffer;
}

export type RecordsBuffer = ReturnType<typeof createRecordsBuffer>;
type RecordsApi = typeof recordsJavaScriptApi;

// Passes of population-records.compute.wat over the first size staged events. Records of the part are at their number
// minus firstRecord; numbers below firstRecord in the tables belong to earlier parts and are free
const recordsJavaScriptApi = {
    // Consecutive events of one sample and class take their record without a lookup
    groupPairs(buffer: RecordsBuffer, size: number, firstRecord: number) {
        const {
            samples,
            classes,
            values,
            slots,
            recordSamples,
            recordClasses,
            recordWeights,
            recordCounts
        } = buffer;
        const slotMask = slots.length - 1;
        let previousSample = -1;
        let previousClass = -1;
        // Index of the record of the previous event among the records of the part
        let index = 0;
        let count = 0;
        let runs = 0;
        let nonzero = 0;

        for (let i = 0; i < size; i++) {
            const sample = samples[i];
            const eventClass = classes[i];
            const value = values[i];

            if (sample !== previousSample || eventClass !== previousClass) {
                let slot = hashPair(sample, eventClass) & slotMask;
                let record = slots[slot];

                while (record >= firstRecord) {
                    index = record - firstRecord;

                    if (recordSamples[index] === sample && recordClasses[index] === eventClass) {
                        break;
                    }

                    slot = (slot + 1) & slotMask;
                    record = slots[slot];
                }

                if (record < firstRecord) {
                    index = count++;
                    addRecord(buffer, index, sample, eventClass);
                    slots[slot] = firstRecord + index;
                }

                if (sample !== previousSample) {
                    runs++;
                }

                previousSample = sample;
                previousClass = eventClass;
            }

            if (value !== 0) {
                recordWeights[index] += value;
                recordCounts[index]++;
                nonzero++;
            }
        }

        buffer.runs[0] = runs;
        buffer.nonzero[0] = nonzero;

        return count;
    },

    // A record of a class numbered before the run's first record belongs to another run, so a sample recurring
    // in the part takes records of its own for every run
    groupRuns(buffer: RecordsBuffer, size: number, firstRecord: number) {
        const {
            samples,
            classes,
            values,
            classRecords,
            recordWeights,
            recordCounts
        } = buffer;
        let runFirstRecord = firstRecord;
        let previousSample = -1;
        let count = 0;
        let runs = 0;
        let nonzero = 0;

        for (let i = 0; i < size; i++) {
            const sample = samples[i];
            const eventClass = classes[i];
            const value = values[i];

            if (sample !== previousSample) {
                runFirstRecord = firstRecord + count;
                previousSample = sample;
                runs++;
            }

            let record = classRecords[eventClass];

            if (record < runFirstRecord) {
                record = firstRecord + count;
                addRecord(buffer, count, sample, eventClass);
                classRecords[eventClass] = record;
                count++;
            }

            if (value !== 0) {
                recordWeights[record - firstRecord] += value;
                recordCounts[record - firstRecord]++;
                nonzero++;
            }
        }

        buffer.runs[0] = runs;
        buffer.nonzero[0] = nonzero;

        return count;
    }
};
export const recordsApiOf = wasmBacked(recordsWasm, recordsJavaScriptApi, bindRecordsWasm);

function addRecord(buffer: RecordsBuffer, index: number, sample: number, eventClass: number) {
    buffer.recordSamples[index] = sample;
    buffer.recordClasses[index] = eventClass;
    buffer.recordWeights[index] = 0;
    buffer.recordCounts[index] = 0;
}

// The hash of groupPairs in population-records.compute.wat
function hashPair(sample: number, eventClass: number) {
    return (Math.imul(sample, 0x9e3779b1) ^ Math.imul(eventClass + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
}

function bindRecordsWasm(wasm: WasmExports<'groupPairs' | 'groupRuns'>): RecordsApi {
    return {
        groupPairs(buffer, size, firstRecord) {
            return wasm.groupPairs(
                size,
                buffer.samples.byteOffset,
                buffer.classes.byteOffset,
                buffer.classes.BYTES_PER_ELEMENT,
                elementMask(buffer.classes),
                buffer.values.byteOffset,
                buffer.slots.byteOffset,
                buffer.slots.length - 1,
                buffer.recordSamples.byteOffset,
                buffer.recordClasses.byteOffset,
                buffer.recordWeights.byteOffset,
                buffer.recordCounts.byteOffset,
                firstRecord,
                buffer.runs.byteOffset,
                buffer.nonzero.byteOffset
            );
        },
        groupRuns(buffer, size, firstRecord) {
            return wasm.groupRuns(
                size,
                buffer.samples.byteOffset,
                buffer.classes.byteOffset,
                buffer.classes.BYTES_PER_ELEMENT,
                elementMask(buffer.classes),
                buffer.values.byteOffset,
                buffer.classRecords.byteOffset,
                buffer.recordSamples.byteOffset,
                buffer.recordClasses.byteOffset,
                buffer.recordWeights.byteOffset,
                buffer.recordCounts.byteOffset,
                firstRecord,
                buffer.runs.byteOffset,
                buffer.nonzero.byteOffset
            );
        }
    };
}
