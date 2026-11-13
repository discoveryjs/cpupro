import { createComputeBuffer, wasmBacked, type WasmExports } from '../computations/compute-wasm.js';
import sourceMapWasm from './source-map.compute.wasm';

// A checkpoint is the state of decoding before a segment of a line: its generated column, the column
// of the previous segment of the line, its offset in the mappings, and the original position fields before it
export const CHECKPOINT_COLUMN = 0;
export const CHECKPOINT_PREVIOUS_COLUMN = 1;
export const CHECKPOINT_OFFSET = 2;
export const CHECKPOINT_SOURCE = 3;
export const CHECKPOINT_ORIGINAL_LINE = 4;
export const CHECKPOINT_ORIGINAL_COLUMN = 5;
export const CHECKPOINT_SIZE = 6;

// PERF: A lookup decodes segments from the nearest checkpoint, so a checkpoint per several segments
// keeps lookups short while the index stays a fraction of the decoded segments
const CHECKPOINT_SEGMENTS = 8;

// The state of the index pass carried over chunks of the mappings, and the counts of the pass
const STATE_LINE = 0;
const STATE_LINE_SEGMENTS = 1;
const STATE_SEGMENTS_AFTER_CHECKPOINT = 2;
const STATE_GENERATED_COLUMN = 3;
const STATE_SOURCE = 4;
const STATE_ORIGINAL_LINE = 5;
const STATE_ORIGINAL_COLUMN = 6;
const STATE_CHECKPOINT_COUNT = 7; // of the mappings so far
const STATE_UNSORTED_LINE_COUNT = 8; // of the chunk
const STATE_SIZE = 9;

// Values of mappings characters: base64 digits, MAPPINGS_SEPARATOR for "," and ";", MAPPINGS_INVALID for the rest;
// both are above the digits. PERF: The table covers all UTF-16 code units, so a lookup over the string takes
// no range check; a non-ASCII character is staged as bytes above 127, which are invalid in the first 256 values
export const MAPPINGS_SEPARATOR = 254;
export const MAPPINGS_INVALID = 255;
export const mappingsCharValues = new Uint8Array(65536).fill(MAPPINGS_INVALID);

for (let i = 0; i < 64; i++) {
    mappingsCharValues['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;
}

mappingsCharValues[44 /* , */] = MAPPINGS_SEPARATOR;
mappingsCharValues[59 /* ; */] = MAPPINGS_SEPARATOR;

// PERF: WASM reads its own memory only, so the mappings are staged into the buffer in chunks of bytes. A chunk
// ends after a separator, so its segments are whole: a valid segment has 5 values at most, of 7 digits at most
// for 32 bits, far fewer characters than a chunk. One buffer serves all indexes, since WASM memory and an instance
// per index cost tens of ms over the source maps of a trace
export const MAPPINGS_CHUNK_SIZE = 1 << 14;
// A segment takes a character at least and segments are separated, so a chunk has at most half its size of segments
const CHUNK_SEGMENTS = MAPPINGS_CHUNK_SIZE / 2;
const mappingsEncoder = new TextEncoder();
let mappingsIndexer: { buffer: MappingsBuffer; api: MappingsApi } | null = null;

export type MappingsIndex = {
    checkpoints: Int32Array; // CHECKPOINT_SIZE values per checkpoint
    lineCheckpoints: Uint32Array; // by line, its first checkpoint; the checkpoints of a line end where the next start
    unsortedLines: Set<number> | null; // lines with a segment before the previous one's generated column
};

// The mappings are decoded in chunks staged as bytes into the buffer; the checkpoints of each chunk are copied out
// of the buffer and joined once the number of checkpoints is known
export function indexMappings(mappings: string): MappingsIndex {
    const { buffer, api } = getMappingsIndexer();
    const state = buffer.state;
    const checkpointChunks: Int32Array[] = [];
    const lineCheckpoints = [0];
    let unsortedLines: Set<number> | null = null;

    state.fill(0);

    for (let start = 0; start < mappings.length;) {
        const end = chunkEnd(mappings, start);
        const line = state[STATE_LINE];
        const checkpointCount = state[STATE_CHECKPOINT_COUNT];
        // A non-ASCII character is invalid, as its bytes are: the bytes before the first one are the characters
        const { written } = mappingsEncoder.encodeInto(mappings.slice(start, end), buffer.mappings);

        // the byte after the chunk is a separator, so a segment ends at it
        buffer.mappings[written] = 44 /* , */;

        const invalidOffset = api.indexMappings(buffer, written, start);

        if (invalidOffset !== -1) {
            throw new Error(`Invalid character in source map mappings at ${start + invalidOffset}`);
        }

        if (state[STATE_CHECKPOINT_COUNT] > checkpointCount) {
            checkpointChunks.push(
                buffer.checkpoints.slice(0, (state[STATE_CHECKPOINT_COUNT] - checkpointCount) * CHECKPOINT_SIZE)
            );
        }

        for (let i = 0; i < state[STATE_LINE] - line; i++) {
            lineCheckpoints.push(buffer.lineCheckpoints[i]);
        }

        for (let i = 0; i < state[STATE_UNSORTED_LINE_COUNT]; i++) {
            unsortedLines ??= new Set();
            unsortedLines.add(buffer.unsortedLines[i]);
        }

        start = end;
    }

    lineCheckpoints.push(state[STATE_CHECKPOINT_COUNT]);

    return {
        checkpoints: joinChunks(checkpointChunks, state[STATE_CHECKPOINT_COUNT] * CHECKPOINT_SIZE),
        lineCheckpoints: new Uint32Array(lineCheckpoints),
        unsortedLines
    };
}

// The end of the chunk of the mappings from a start: the end of the mappings, or the end of the chunk's
// last separator
function chunkEnd(mappings: string, start: number) {
    let end = start + MAPPINGS_CHUNK_SIZE;

    if (end >= mappings.length) {
        return mappings.length;
    }

    while (end > start && mappings.charCodeAt(end - 1) !== 44 /* , */ && mappings.charCodeAt(end - 1) !== 59 /* ; */) {
        end--;
    }

    if (end === start) {
        throw new Error(`Too long segment in source map mappings at ${start}`);
    }

    return end;
}

function joinChunks(chunks: Int32Array[], length: number) {
    const joined = new Int32Array(length);
    let offset = 0;

    for (let i = 0; i < chunks.length; i++) {
        joined.set(chunks[i], offset);
        offset += chunks[i].length;
    }

    return joined;
}

function getMappingsIndexer() {
    if (mappingsIndexer === null) {
        const buffer = createMappingsBuffer();

        mappingsIndexer = {
            buffer,
            api: mappingsApiOf(buffer)
        };
    }

    return mappingsIndexer;
}

// A chunk of mappings bytes, the values of bytes and the state of the pass, and what the pass finds in the chunk:
// checkpoints, the first checkpoints of the lines it starts and unsorted lines
function createMappingsBuffer() {
    const buffer = createComputeBuffer({
        // a UTF-16 code unit takes 3 bytes of UTF-8 at most, and a separator follows the chunk
        mappings: [Uint8Array, 3 * MAPPINGS_CHUNK_SIZE + 1],
        charValues: [Uint8Array, 256],
        state: [Int32Array, STATE_SIZE],
        checkpoints: [Int32Array, CHUNK_SEGMENTS * CHECKPOINT_SIZE],
        lineCheckpoints: [Uint32Array, MAPPINGS_CHUNK_SIZE],
        unsortedLines: [Uint32Array, CHUNK_SEGMENTS]
    });

    buffer.charValues.set(mappingsCharValues.subarray(0, 256));

    return buffer;
}

type MappingsBuffer = ReturnType<typeof createMappingsBuffer>;
type MappingsApi = typeof mappingsJavaScriptApi;

// The index pass (source-map.compute.wat) over the first size bytes of the chunk at a start of the mappings,
// a separator follows them: decodes the segments of the chunk from the state, writes the checkpoints of the chunk,
// the first checkpoints of the lines it starts and its unsorted lines; returns -1, or the offset of an invalid byte
// in the chunk
const mappingsJavaScriptApi = {
    indexMappings(buffer: MappingsBuffer, size: number, start: number) {
        const { mappings, charValues, state, checkpoints, lineCheckpoints, unsortedLines } = buffer;
        let line = state[STATE_LINE];
        let lineSegments = state[STATE_LINE_SEGMENTS];
        let segmentsAfterCheckpoint = state[STATE_SEGMENTS_AFTER_CHECKPOINT];
        let generatedColumn = state[STATE_GENERATED_COLUMN];
        let source = state[STATE_SOURCE];
        let originalLine = state[STATE_ORIGINAL_LINE];
        let originalColumn = state[STATE_ORIGINAL_COLUMN];
        let checkpointCount = state[STATE_CHECKPOINT_COUNT];
        let checkpoint = 0;
        let lineCount = 0;
        let unsortedLineCount = 0;

        for (let offset = 0; offset < size;) {
            const byte = mappings[offset];

            if (byte === 59 /* ; */) {
                lineCheckpoints[lineCount++] = checkpointCount;
                line++;
                lineSegments = 0;
                generatedColumn = 0; // a generated column is relative to the previous segment of its line
                offset++;
                continue;
            }

            if (byte === 44 /* , */) {
                offset++;
                continue;
            }

            const segmentOffset = offset;
            let fieldCount = 0;
            let digit = charValues[byte];

            // A segment is a sequence of base64 VLQ values up to a separator, the one after the chunk included
            while (digit < MAPPINGS_SEPARATOR) {
                let value = digit & 31;
                let shift = 5;

                // A digit with the continuation bit is followed by more digits of the value
                while (digit & 32) {
                    offset++;
                    digit = charValues[mappings[offset]];

                    if (digit >= MAPPINGS_SEPARATOR) {
                        return offset;
                    }

                    value |= (digit & 31) << shift;
                    shift += 5;
                }

                const delta = value & 1
                    ? -(value >>> 1)
                    : value >>> 1;

                // the fields are the generated column, source, original line and column, a name isn't used
                if (fieldCount === 0) {
                    const column = generatedColumn + delta;

                    // The decisions of a segment take the fields before it, which the fields after the generated
                    // column still are. The spec doesn't require segments of a line to be sorted by generated column,
                    // a lookup scans an unsorted line whole
                    if (lineSegments > 0 && column < generatedColumn) {
                        unsortedLines[unsortedLineCount++] = line;
                    }

                    // A line starts with a checkpoint, and a checkpoint doesn't come between segments at the same
                    // column, so the segments at the column of a lookup's result come after the checkpoint
                    // it starts with
                    if (lineSegments === 0 || (
                        segmentsAfterCheckpoint >= CHECKPOINT_SEGMENTS &&
                        column > generatedColumn
                    )) {
                        checkpoints[checkpoint + CHECKPOINT_COLUMN] = column;
                        checkpoints[checkpoint + CHECKPOINT_PREVIOUS_COLUMN] = generatedColumn;
                        checkpoints[checkpoint + CHECKPOINT_OFFSET] = start + segmentOffset;
                        checkpoints[checkpoint + CHECKPOINT_SOURCE] = source;
                        checkpoints[checkpoint + CHECKPOINT_ORIGINAL_LINE] = originalLine;
                        checkpoints[checkpoint + CHECKPOINT_ORIGINAL_COLUMN] = originalColumn;
                        checkpoint += CHECKPOINT_SIZE;
                        checkpointCount++;
                        segmentsAfterCheckpoint = 0;
                    }

                    generatedColumn = column;
                    lineSegments++;
                    segmentsAfterCheckpoint++;
                } else if (fieldCount === 1) {
                    source += delta;
                } else if (fieldCount === 2) {
                    originalLine += delta;
                } else if (fieldCount === 3) {
                    originalColumn += delta;
                }

                fieldCount++;
                offset++;
                digit = charValues[mappings[offset]];
            }

            if (digit === MAPPINGS_INVALID) {
                return offset;
            }
        }

        state[STATE_LINE] = line;
        state[STATE_LINE_SEGMENTS] = lineSegments;
        state[STATE_SEGMENTS_AFTER_CHECKPOINT] = segmentsAfterCheckpoint;
        state[STATE_GENERATED_COLUMN] = generatedColumn;
        state[STATE_SOURCE] = source;
        state[STATE_ORIGINAL_LINE] = originalLine;
        state[STATE_ORIGINAL_COLUMN] = originalColumn;
        state[STATE_CHECKPOINT_COUNT] = checkpointCount;
        state[STATE_UNSORTED_LINE_COUNT] = unsortedLineCount;

        return -1;
    }
};
const mappingsApiOf = wasmBacked(sourceMapWasm, mappingsJavaScriptApi, bindMappingsWasm);

function bindMappingsWasm(wasm: WasmExports<'indexMappings'>): MappingsApi {
    return {
        indexMappings(buffer, size, start) {
            return wasm.indexMappings(
                size,
                start,
                buffer.mappings.byteOffset,
                buffer.charValues.byteOffset,
                buffer.state.byteOffset,
                buffer.checkpoints.byteOffset,
                buffer.lineCheckpoints.byteOffset,
                buffer.unsortedLines.byteOffset,
                CHECKPOINT_SEGMENTS
            );
        }
    };
}
