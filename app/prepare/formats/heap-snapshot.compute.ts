import { createComputeBuffer, wasmBacked, type WasmExports } from '../computations/compute-wasm.js';
import heapSnapshotWasm from './heap-snapshot.compute.wasm';

// The state of a scan carried over slices of a section, and what the scan of a slice found
export const STATE_VALUE_LOW = 0;       // the value being read, as u64
export const STATE_VALUE_HIGH = 1;
export const STATE_DIGIT = 2;           // the value has a digit; for strings: the scan is inside a string
export const STATE_NEGATIVE = 3;        // the value is negative; for strings: the next byte is escaped
export const STATE_COUNT = 4;           // values of the slice
export const STATE_EXCEPTION_COUNT = 5; // values of the slice out of u32 range
export const STATE_STRING_COUNT = 6;    // strings started in the slice
export const STATE_OUT_OF_RANGE = 7;    // values of the slice out of u32 range aren't among its exceptions yet
export const STATE_SIZE = 8;

// PERF: WASM reads its own memory only, so sections are staged into the buffer in slices of bytes. A value
// takes a digit and a separator at least, so a slice has at most half its size of values; an exception
// takes 11 digits at least
export const SLICE_SIZE = 1 << 20;
const SLICE_VALUES = SLICE_SIZE / 2 + 1;
const SLICE_EXCEPTIONS = Math.ceil(SLICE_SIZE / 11);
export const MAX_FIELDS = 64;

export function createSliceBuffer() {
    return createComputeBuffer({
        exceptionValues: [Float64Array, SLICE_EXCEPTIONS],
        bytes: [Uint8Array, SLICE_SIZE],
        values: [Uint32Array, SLICE_VALUES],              // or offsets of strings
        fields: [Uint32Array, SLICE_VALUES],              // the values by field
        divisors: [Uint32Array, MAX_FIELDS],              // per field of the section
        exceptionIndices: [Uint32Array, SLICE_EXCEPTIONS], // among the values of the slice
        state: [Uint32Array, STATE_SIZE]
    });
}

export type SliceBuffer = ReturnType<typeof createSliceBuffer>;
export type ScanApi = typeof scanJavaScriptApi;

// Scans of heap-snapshot.compute.wat over the first size staged bytes of a slice; return the offset after
// the "]" closing the section, or -1. The JavaScript scan of numbers takes exceptions as it goes
const scanJavaScriptApi = {
    scanNumbers(buffer: SliceBuffer, size: number) {
        return scanJavaScriptApi.scanExceptions(buffer, size);
    },

    // A value is a run of digits, "-" before them makes it negative, any other byte ends it
    scanExceptions(buffer: SliceBuffer, size: number) {
        const { bytes, values, exceptionIndices, exceptionValues, state } = buffer;
        let value = state[STATE_VALUE_HIGH] * 0x100000000 + state[STATE_VALUE_LOW];
        let hasDigit = state[STATE_DIGIT];
        let negative = state[STATE_NEGATIVE];
        let count = 0;
        let exceptionCount = 0;
        let closed = -1;

        for (let offset = 0; offset < size;) {
            const byte = bytes[offset++];
            const digit = byte - 48;

            if (digit >= 0 && digit < 10) {
                value = value * 10 + digit;
                hasDigit = 1;
                continue;
            }

            if (byte === 45 /* - */) {
                negative = 1;
                continue;
            }

            if (hasDigit) {
                if (negative || value > 0xFFFFFFFF) {
                    exceptionIndices[exceptionCount] = count;
                    exceptionValues[exceptionCount] = negative
                        ? -value
                        : value;
                    exceptionCount++;
                }

                values[count++] = value;
            }

            value = 0;
            hasDigit = 0;
            negative = 0;

            if (byte === 93 /* ] */) {
                closed = offset;
                break;
            }
        }

        state[STATE_VALUE_LOW] = value;
        state[STATE_VALUE_HIGH] = value / 0x100000000;
        state[STATE_DIGIT] = hasDigit;
        state[STATE_NEGATIVE] = negative;
        state[STATE_COUNT] = count;
        state[STATE_EXCEPTION_COUNT] = exceptionCount;
        state[STATE_OUT_OF_RANGE] = 0;

        return closed;
    },

    // The values of a field, every fieldCount-th from the first of the field, go to fields after the values
    // of the fields before it
    splitFields(buffer: SliceBuffer, count: number, fieldCount: number, firstField: number) {
        const { values, fields, divisors } = buffer;
        let out = 0;

        for (let i = 0; i < fieldCount; i++) {
            const divisor = divisors[i];
            const first = (i + fieldCount - firstField) % fieldCount;

            if (divisor === 1) {
                for (let j = first; j < count; j += fieldCount) {
                    fields[out++] = values[j];
                }
            } else {
                for (let j = first; j < count; j += fieldCount) {
                    fields[out++] = values[j] / divisor;
                }
            }
        }
    },

    // Offsets of the strings of a slice: of the first byte after the opening quote, from the start of the section
    scanStrings(buffer: SliceBuffer, size: number, sectionOffset: number) {
        const { bytes, values: starts, state } = buffer;
        let inString = state[STATE_DIGIT];
        let escaped = state[STATE_NEGATIVE];
        let count = 0;
        let closed = -1;

        for (let offset = 0; offset < size;) {
            const byte = bytes[offset++];

            if (inString) {
                if (escaped) {
                    escaped = 0;
                } else if (byte === 92 /* \ */) {
                    escaped = 1;
                } else if (byte === 34 /* " */) {
                    inString = 0;
                }

                continue;
            }

            if (byte === 34 /* " */) {
                inString = 1;
                starts[count++] = sectionOffset + offset;
                continue;
            }

            if (byte === 93 /* ] */) {
                closed = offset;
                break;
            }
        }

        state[STATE_DIGIT] = inString;
        state[STATE_NEGATIVE] = escaped;
        state[STATE_STRING_COUNT] = count;

        return closed;
    }
};

export const scanApiOf = wasmBacked(heapSnapshotWasm, scanJavaScriptApi, bindScanWasm);

function bindScanWasm(wasm: WasmExports<'scanNumbers' | 'scanExceptions' | 'splitFields' | 'scanStrings'>): ScanApi {
    return {
        splitFields(buffer, count, fieldCount, firstField) {
            wasm.splitFields(
                count,
                fieldCount,
                firstField,
                buffer.values.byteOffset,
                buffer.fields.byteOffset,
                buffer.divisors.byteOffset
            );
        },
        scanNumbers(buffer, size) {
            return wasm.scanNumbers(
                size,
                buffer.bytes.byteOffset,
                buffer.values.byteOffset,
                buffer.state.byteOffset
            );
        },
        scanExceptions(buffer, size) {
            return wasm.scanExceptions(
                size,
                buffer.bytes.byteOffset,
                buffer.values.byteOffset,
                buffer.exceptionIndices.byteOffset,
                buffer.exceptionValues.byteOffset,
                buffer.state.byteOffset
            );
        },
        scanStrings(buffer, size, sectionOffset) {
            return wasm.scanStrings(
                size,
                buffer.bytes.byteOffset,
                buffer.values.byteOffset,
                sectionOffset,
                buffer.state.byteOffset
            );
        }
    };
}
