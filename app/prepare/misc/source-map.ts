import { computeSourceURL, isAbsolute, normalize, relative } from 'source-map-js/lib/util.js';
import type { SourceMap } from '../types.js';

// Values of mappings characters: base64 digits, SEPARATOR for "," and ";", INVALID for the rest.
// PERF: The table covers all UTF-16 code units, so a lookup takes no range check
const SEPARATOR = -2;
const INVALID = -1;
const mappingsCharValues = new Int8Array(65536).fill(INVALID);

for (let i = 0; i < 64; i++) {
    mappingsCharValues['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;
}

mappingsCharValues[44 /* , */] = SEPARATOR;
mappingsCharValues[59 /* ; */] = SEPARATOR;

// Fields of a segment, accumulated over the mappings (names aren't used),
// and the number of fields of the last decoded segment
const GENERATED_COLUMN = 0;
const SOURCE = 1;
const ORIGINAL_LINE = 2;
const ORIGINAL_COLUMN = 3;
const SEGMENT_FIELD_COUNT = 4;

// A checkpoint is the state of decoding before a segment of a line: its generated column, the column
// of the previous segment of the line, its offset in the mappings, and the original position fields before it
const CHECKPOINT_COLUMN = 0;
const CHECKPOINT_PREVIOUS_COLUMN = 1;
const CHECKPOINT_OFFSET = 2;
const CHECKPOINT_SOURCE = 3;
const CHECKPOINT_ORIGINAL_LINE = 4;
const CHECKPOINT_ORIGINAL_COLUMN = 5;
const CHECKPOINT_SIZE = 6;

// PERF: A lookup decodes segments from the nearest checkpoint, so a checkpoint per several segments
// keeps lookups short while the index stays a fraction of the decoded segments
const CHECKPOINT_SEGMENTS = 8;

// Decodes the segment at an offset of the mappings into the fields, returns the offset after the segment
function decodeSegment(mappings: string, offset: number, fields: Int32Array) {
    const end = mappings.length;
    let fieldCount = 0;
    let digit = mappingsCharValues[mappings.charCodeAt(offset)];

    // A segment is a sequence of base64 VLQ values up to a separator or the end of the mappings
    while (digit >= 0) {
        let value = digit & 31;
        let shift = 5;

        // A digit with the continuation bit is followed by more digits of the value
        while (digit & 32) {
            offset++;
            digit = offset < end
                ? mappingsCharValues[mappings.charCodeAt(offset)]
                : INVALID;

            if (digit < 0) {
                throw new Error(`Invalid character in source map mappings at ${offset}`);
            }

            value |= (digit & 31) << shift;
            shift += 5;
        }

        if (fieldCount <= ORIGINAL_COLUMN) {
            fields[fieldCount] += value & 1
                ? -(value >>> 1)
                : value >>> 1;
        }

        fieldCount++;
        offset++;
        digit = offset < end
            ? mappingsCharValues[mappings.charCodeAt(offset)]
            : SEPARATOR;
    }

    if (digit === INVALID) {
        throw new Error(`Invalid character in source map mappings at ${offset}`);
    }

    fields[SEGMENT_FIELD_COUNT] = fieldCount;

    return offset;
}

// Whether a segment comes before another one at the same generated column in the order of source-map-js:
// segments with an original position first, by their source, original line and column
function precedes(
    source: number, // -1 when the segment has no original position
    line: number,
    column: number,
    otherSource: number,
    otherLine: number,
    otherColumn: number
) {
    if (source === -1) {
        return false;
    }

    if (otherSource === -1) {
        return true;
    }

    if (source !== otherSource) {
        return source < otherSource;
    }

    if (line !== otherLine) {
        return line < otherLine;
    }

    return column < otherColumn;
}

// Looks up original positions of generated positions, lines and columns are 0-based. The deltas of segment fields
// accumulate over the whole mappings, so finding a segment needs the decoding state before it: the mappings
// are decoded once to keep the state at checkpoints only, a lookup decodes the few segments after a checkpoint.
export type OriginalPosition = {
    source: number; // an index in the sources of the source map
    line: number;
    column: number;
};

export class SourceMapIndex {
    sources: string[];
    sourcesContent: (string | null)[];

    #mappings: string;
    #fields: Int32Array;
    #checkpoints: Int32Array;
    #lineCheckpoints: Uint32Array; // by line, its first checkpoint; the checkpoints of a line end where the next start
    #unsortedLines: Set<number> | null = null;

    constructor(sourceMap: SourceMap) {
        const sourceRoot = sourceMap.sourceRoot
            ? normalize(sourceMap.sourceRoot)
            : null;

        // Source URLs are resolved the same way as source-map-js does for a source map without its own URL
        this.sources = sourceMap.sources.map(source => {
            const normalizedSource = normalize(String(source));

            return computeSourceURL(
                sourceRoot,
                sourceRoot !== null && isAbsolute(sourceRoot) && isAbsolute(normalizedSource)
                    ? relative(sourceRoot, normalizedSource)
                    : normalizedSource
            );
        });
        this.sourcesContent = sourceMap.sourcesContent || [];
        this.#mappings = sourceMap.mappings;
        this.#fields = new Int32Array(SEGMENT_FIELD_COUNT + 1);
        this.#index();
    }

    #index() {
        const mappings = this.#mappings;
        const fields = this.#fields;
        // the numbers of checkpoints and lines are known once the mappings are decoded
        const checkpoints: number[] = [];
        const lineCheckpoints = [0];
        let line = 0;
        let lineSegments = 0;
        let segmentsAfterCheckpoint = 0;

        for (let i = 0; i < mappings.length;) {
            const code = mappings.charCodeAt(i);

            if (code === 59 /* ; */) {
                line++;
                lineCheckpoints.push(checkpoints.length / CHECKPOINT_SIZE);
                lineSegments = 0;
                fields[GENERATED_COLUMN] = 0; // a generated column is relative to the previous segment of its line
                i++;
                continue;
            }

            if (code === 44 /* , */) {
                i++;
                continue;
            }

            const offset = i;
            const previousColumn = fields[GENERATED_COLUMN];
            const source = fields[SOURCE];
            const originalLine = fields[ORIGINAL_LINE];
            const originalColumn = fields[ORIGINAL_COLUMN];

            i = decodeSegment(mappings, i, fields);

            // The spec doesn't require segments of a line to be sorted by generated column,
            // a lookup scans an unsorted line whole
            if (lineSegments > 0 && fields[GENERATED_COLUMN] < previousColumn) {
                this.#unsortedLines ??= new Set();
                this.#unsortedLines.add(line);
            }

            // A line starts with a checkpoint, and a checkpoint doesn't come between segments at the same column,
            // so the segments at the column of a lookup's result come after the checkpoint it starts with
            if (lineSegments === 0 ||
                (segmentsAfterCheckpoint >= CHECKPOINT_SEGMENTS && fields[GENERATED_COLUMN] > previousColumn)) {
                checkpoints.push(
                    fields[GENERATED_COLUMN], // CHECKPOINT_COLUMN
                    previousColumn, // CHECKPOINT_PREVIOUS_COLUMN
                    offset, // CHECKPOINT_OFFSET
                    source, // CHECKPOINT_SOURCE
                    originalLine, // CHECKPOINT_ORIGINAL_LINE
                    originalColumn // CHECKPOINT_ORIGINAL_COLUMN
                );
                segmentsAfterCheckpoint = 0;
            }

            lineSegments++;
            segmentsAfterCheckpoint++;
        }

        lineCheckpoints.push(checkpoints.length / CHECKPOINT_SIZE);
        this.#checkpoints = new Int32Array(checkpoints);
        this.#lineCheckpoints = new Uint32Array(lineCheckpoints);
    }

    // The checkpoint to decode a line from for a lookup at a column: the last one of the line at or before the column,
    // or the first one of the line when the line is unsorted; -1 when the line has no segments at or before the column
    #findCheckpoint(line: number, column: number, unsortedLine: boolean) {
        const checkpoints = this.#checkpoints;
        const lineCheckpoints = this.#lineCheckpoints;

        if (line + 1 >= lineCheckpoints.length) {
            return -1;
        }

        const lineStart = lineCheckpoints[line];
        const lineEnd = lineCheckpoints[line + 1];

        if (lineStart === lineEnd) {
            return -1;
        }

        if (unsortedLine) {
            return lineStart;
        }

        let low = lineStart;
        let high = lineEnd - 1;
        let checkpoint = -1;

        while (low <= high) {
            const mid = (low + high) >>> 1;

            if (checkpoints[mid * CHECKPOINT_SIZE + CHECKPOINT_COLUMN] <= column) {
                checkpoint = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        return checkpoint;
    }

    // Finds the segment covering a generated position, i.e. the first in the order of source-map-js of the segments
    // at the rightmost column at or before the column on the same line. Returns the original position of the segment,
    // or null when there is no such segment or it has no original position
    findOriginalPosition(line: number, column: number): OriginalPosition | null {
        const unsortedLine = this.#unsortedLines !== null && this.#unsortedLines.has(line);
        const checkpoint = this.#findCheckpoint(line, column, unsortedLine);

        if (checkpoint === -1) {
            return null;
        }

        const mappings = this.#mappings;
        const fields = this.#fields;
        const checkpointIndex = checkpoint * CHECKPOINT_SIZE;
        let segmentColumn = -1;
        let segmentSource = -1;
        let segmentLine = 0;
        let segmentOriginalColumn = 0;

        fields[GENERATED_COLUMN] = this.#checkpoints[checkpointIndex + CHECKPOINT_PREVIOUS_COLUMN];
        fields[SOURCE] = this.#checkpoints[checkpointIndex + CHECKPOINT_SOURCE];
        fields[ORIGINAL_LINE] = this.#checkpoints[checkpointIndex + CHECKPOINT_ORIGINAL_LINE];
        fields[ORIGINAL_COLUMN] = this.#checkpoints[checkpointIndex + CHECKPOINT_ORIGINAL_COLUMN];

        for (let i = this.#checkpoints[checkpointIndex + CHECKPOINT_OFFSET]; i < mappings.length;) {
            const code = mappings.charCodeAt(i);

            if (code === 59 /* ; */) {
                break;
            }

            if (code === 44 /* , */) {
                i++;
                continue;
            }

            i = decodeSegment(mappings, i, fields);

            const generatedColumn = fields[GENERATED_COLUMN];

            if (generatedColumn > column) {
                if (unsortedLine) {
                    continue;
                }

                break;
            }

            // a segment of 4 or 5 fields has an original position
            const source = fields[SEGMENT_FIELD_COUNT] >= 4
                ? fields[SOURCE]
                : -1;
            const originalLine = fields[ORIGINAL_LINE];
            const originalColumn = fields[ORIGINAL_COLUMN];
            const covers = generatedColumn === segmentColumn
                ? precedes(source, originalLine, originalColumn, segmentSource, segmentLine, segmentOriginalColumn)
                : generatedColumn > segmentColumn;

            if (covers) {
                segmentColumn = generatedColumn;
                segmentSource = source;
                segmentLine = originalLine;
                segmentOriginalColumn = originalColumn;
            }
        }

        if (segmentSource === -1 || segmentSource >= this.sources.length) {
            return null;
        }

        return {
            source: segmentSource,
            line: segmentLine,
            column: segmentOriginalColumn
        };
    }
}
