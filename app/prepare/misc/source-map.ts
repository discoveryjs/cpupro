import { computeSourceURL, isAbsolute, normalize, relative } from 'source-map-js/lib/util.js';
import {
    CHECKPOINT_COLUMN,
    CHECKPOINT_OFFSET,
    CHECKPOINT_ORIGINAL_COLUMN,
    CHECKPOINT_ORIGINAL_LINE,
    CHECKPOINT_PREVIOUS_COLUMN,
    CHECKPOINT_SIZE,
    CHECKPOINT_SOURCE,
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

// Decodes the segment at an offset of the mappings into the fields, returns the offset after the segment;
// the index checked the mappings, so a value ends with a digit and a segment with a separator or the end
function decodeSegment(mappings: string, offset: number, fields: Int32Array) {
    const end = mappings.length;
    let fieldCount = 0;
    let digit = mappingsCharValues[mappings.charCodeAt(offset)];

    while (digit < MAPPINGS_SEPARATOR) {
        let value = digit & 31;
        let shift = 5;

        // A digit with the continuation bit is followed by more digits of the value
        while (digit & 32) {
            offset++;
            digit = mappingsCharValues[mappings.charCodeAt(offset)];
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

// The segments covering the columns of an unsorted line, by column ascending; a source of -1 for a segment
// without an original position
type SortedLine = {
    columns: Int32Array;
    sources: Int32Array;
    lines: Int32Array;
    originalColumns: Int32Array;
};

export class SourceMapIndex {
    sources: string[];
    sourcesContent: (string | null)[];

    #mappings: string;
    #checkpoints: Int32Array;
    #lineCheckpoints: Uint32Array;
    #unsortedLines: Set<number> | null;
    #sortedLines: Map<number, SortedLine>; // of the unsorted lines looked up

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

        const index = indexMappings(sourceMap.mappings);

        this.#checkpoints = index.checkpoints;
        this.#lineCheckpoints = index.lineCheckpoints;
        this.#unsortedLines = index.unsortedLines;
        this.#sortedLines = new Map();
    }

    // The checkpoint to decode a sorted line from for a lookup at a column: the last one of the line at or before
    // the column; -1 when the line has no segments at or before the column
    #findCheckpoint(line: number, column: number) {
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
        // PERF: A lookup on an unsorted line would decode the whole line, and a minified bundle is a single line
        // of up to a million segments, so the line is sorted once, on its first lookup
        if (this.#unsortedLines !== null && this.#unsortedLines.has(line)) {
            let sortedLine = this.#sortedLines.get(line);

            if (sortedLine === undefined) {
                sortedLine = this.#sortLine(line);
                this.#sortedLines.set(line, sortedLine);
            }

            return this.#findSortedLinePosition(sortedLine, column);
        }

        const checkpoint = this.#findCheckpoint(line, column);

        if (checkpoint === -1) {
            return null;
        }

        const mappings = this.#mappings;
        const end = mappings.length;
        const checkpointIndex = checkpoint * CHECKPOINT_SIZE;
        let generatedColumn = this.#checkpoints[checkpointIndex + CHECKPOINT_PREVIOUS_COLUMN];
        let source = this.#checkpoints[checkpointIndex + CHECKPOINT_SOURCE];
        let originalLine = this.#checkpoints[checkpointIndex + CHECKPOINT_ORIGINAL_LINE];
        let originalColumn = this.#checkpoints[checkpointIndex + CHECKPOINT_ORIGINAL_COLUMN];
        let segmentColumn = -1;
        let segmentSource = -1;
        let segmentLine = 0;
        let segmentOriginalColumn = 0;

        // PERF: The values of a segment are decoded one by one, each by its own copy of the decoding, and a segment
        // after the column is left once its generated column is decoded. The index checked the mappings, so a value
        // ends with a digit and a segment with a separator or the end of the mappings. Over the lookups of a large
        // trace (340K) it took 55 ms in Chrome with a function decoding a segment, 49 ms with a function decoding
        // a value, 48 ms with a loop over the values after the generated column and 45 ms with the copies
        for (let i = this.#checkpoints[checkpointIndex + CHECKPOINT_OFFSET]; i < end;) {
            const code = mappings.charCodeAt(i);

            if (code === 59 /* ; */) {
                break;
            }

            if (code === 44 /* , */) {
                i++;
                continue;
            }

            // the generated column
            let digit = mappingsCharValues[code];
            let value = digit & 31;
            let shift = 5;

            while (digit & 32) {
                i++;
                digit = mappingsCharValues[mappings.charCodeAt(i)];
                value |= (digit & 31) << shift;
                shift += 5;
            }

            i++;
            generatedColumn += value & 1
                ? -(value >>> 1)
                : value >>> 1;

            // the line is sorted, so neither the segment nor the ones after it are at or before the column
            if (generatedColumn > column) {
                break;
            }

            // a segment of 4 or 5 values has an original position, a value after the original column (a name)
            // isn't used
            let decodedSource = -1;

            digit = i < end
                ? mappingsCharValues[mappings.charCodeAt(i)]
                : MAPPINGS_SEPARATOR;

            if (digit < MAPPINGS_SEPARATOR) {
                // the source
                value = digit & 31;
                shift = 5;

                while (digit & 32) {
                    i++;
                    digit = mappingsCharValues[mappings.charCodeAt(i)];
                    value |= (digit & 31) << shift;
                    shift += 5;
                }

                i++;
                source += value & 1
                    ? -(value >>> 1)
                    : value >>> 1;
                digit = i < end
                    ? mappingsCharValues[mappings.charCodeAt(i)]
                    : MAPPINGS_SEPARATOR;

                if (digit < MAPPINGS_SEPARATOR) {
                    // the original line
                    value = digit & 31;
                    shift = 5;

                    while (digit & 32) {
                        i++;
                        digit = mappingsCharValues[mappings.charCodeAt(i)];
                        value |= (digit & 31) << shift;
                        shift += 5;
                    }

                    i++;
                    originalLine += value & 1
                        ? -(value >>> 1)
                        : value >>> 1;
                    digit = i < end
                        ? mappingsCharValues[mappings.charCodeAt(i)]
                        : MAPPINGS_SEPARATOR;

                    if (digit < MAPPINGS_SEPARATOR) {
                        // the original column
                        value = digit & 31;
                        shift = 5;

                        while (digit & 32) {
                            i++;
                            digit = mappingsCharValues[mappings.charCodeAt(i)];
                            value |= (digit & 31) << shift;
                            shift += 5;
                        }

                        i++;
                        originalColumn += value & 1
                            ? -(value >>> 1)
                            : value >>> 1;
                        decodedSource = source;

                        while (i < end && mappingsCharValues[mappings.charCodeAt(i)] < MAPPINGS_SEPARATOR) {
                            i++;
                        }
                    }
                }
            }

            const covers = generatedColumn === segmentColumn
                ? precedes(decodedSource, originalLine, originalColumn, segmentSource, segmentLine, segmentOriginalColumn)
                : generatedColumn > segmentColumn;

            if (covers) {
                segmentColumn = generatedColumn;
                segmentSource = decodedSource;
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

    // The segments covering the columns of an unsorted line: its segments decoded and ordered by column
    #sortLine(line: number): SortedLine {
        const mappings = this.#mappings;
        const fields = new Int32Array(SEGMENT_FIELD_COUNT + 1);
        const checkpointIndex = this.#lineCheckpoints[line] * CHECKPOINT_SIZE;
        const segmentColumns: number[] = [];
        const segmentSources: number[] = [];
        const segmentLines: number[] = [];
        const segmentOriginalColumns: number[] = [];

        fields[GENERATED_COLUMN] = 0;
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

            // a segment of 4 or 5 fields has an original position
            const source = fields[SEGMENT_FIELD_COUNT] >= 4
                ? fields[SOURCE]
                : -1;

            segmentColumns.push(fields[GENERATED_COLUMN]);
            segmentSources.push(source);
            segmentLines.push(fields[ORIGINAL_LINE]);
            segmentOriginalColumns.push(fields[ORIGINAL_COLUMN]);
        }

        // the segments by column; of the segments at a column, the one covering it is the first in the order
        // of source-map-js
        const segmentCount = segmentColumns.length;
        const order = new Uint32Array(segmentCount);
        const byColumn = (a: number, b: number) => segmentColumns[a] - segmentColumns[b];
        const columns = new Int32Array(segmentCount);
        const sources = new Int32Array(segmentCount);
        const lines = new Int32Array(segmentCount);
        const originalColumns = new Int32Array(segmentCount);
        let columnCount = 0;

        for (let i = 0; i < segmentCount; i++) {
            order[i] = i;
        }

        order.sort(byColumn);

        for (let i = 0; i < segmentCount; i++) {
            const segment = order[i];
            const column = segmentColumns[segment];
            const source = segmentSources[segment];
            const originalLine = segmentLines[segment];
            const originalColumn = segmentOriginalColumns[segment];

            if (columnCount === 0 || columns[columnCount - 1] !== column) {
                columnCount++;
            } else if (!precedes(
                source,
                originalLine,
                originalColumn,
                sources[columnCount - 1],
                lines[columnCount - 1],
                originalColumns[columnCount - 1]
            )) {
                continue;
            }

            columns[columnCount - 1] = column;
            sources[columnCount - 1] = source;
            lines[columnCount - 1] = originalLine;
            originalColumns[columnCount - 1] = originalColumn;
        }

        return {
            columns: columns.subarray(0, columnCount),
            sources: sources.subarray(0, columnCount),
            lines: lines.subarray(0, columnCount),
            originalColumns: originalColumns.subarray(0, columnCount)
        };
    }

    // The original position at the rightmost column at or before a column of a sorted line
    #findSortedLinePosition(sortedLine: SortedLine, column: number): OriginalPosition | null {
        const { columns } = sortedLine;
        let low = 0;
        let high = columns.length - 1;
        let index = -1;

        while (low <= high) {
            const mid = (low + high) >>> 1;

            if (columns[mid] <= column) {
                index = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        if (index === -1) {
            return null;
        }

        const source = sortedLine.sources[index];

        if (source === -1 || source >= this.sources.length) {
            return null;
        }

        return {
            source,
            line: sortedLine.lines[index],
            column: sortedLine.originalColumns[index]
        };
    }
}
