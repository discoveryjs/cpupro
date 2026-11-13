import { computeSourceURL, isAbsolute, normalize, relative } from 'source-map-js/lib/util.js';
import {
    CHECKPOINT_COLUMN,
    CHECKPOINT_OFFSET,
    CHECKPOINT_ORIGINAL_COLUMN,
    CHECKPOINT_ORIGINAL_LINE,
    CHECKPOINT_PREVIOUS_COLUMN,
    CHECKPOINT_SIZE,
    CHECKPOINT_SOURCE,
    MAPPINGS_INVALID,
    MAPPINGS_SEPARATOR,
    indexMappings,
    mappingsCharValues
} from './source-map.compute.js';
import type { SourceMap } from '../types.js';

// Fields of a segment, accumulated over the mappings (names aren't used),
// and the number of fields of the last decoded segment
const GENERATED_COLUMN = 0;
const SOURCE = 1;
const ORIGINAL_LINE = 2;
const ORIGINAL_COLUMN = 3;
const SEGMENT_FIELD_COUNT = 4;

// Decodes the segment at an offset of the mappings into the fields, returns the offset after the segment
function decodeSegment(mappings: string, offset: number, fields: Int32Array) {
    const end = mappings.length;
    let fieldCount = 0;
    let digit = mappingsCharValues[mappings.charCodeAt(offset)];

    // A segment is a sequence of base64 VLQ values up to a separator or the end of the mappings
    while (digit < MAPPINGS_SEPARATOR) {
        let value = digit & 31;
        let shift = 5;

        // A digit with the continuation bit is followed by more digits of the value
        while (digit & 32) {
            offset++;
            digit = offset < end
                ? mappingsCharValues[mappings.charCodeAt(offset)]
                : MAPPINGS_INVALID;

            if (digit >= MAPPINGS_SEPARATOR) {
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
            : MAPPINGS_SEPARATOR;
    }

    if (digit === MAPPINGS_INVALID) {
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
    #lineCheckpoints: Uint32Array;
    #unsortedLines: Set<number> | null;

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

        const index = indexMappings(sourceMap.mappings);

        this.#checkpoints = index.checkpoints;
        this.#lineCheckpoints = index.lineCheckpoints;
        this.#unsortedLines = index.unsortedLines;
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
