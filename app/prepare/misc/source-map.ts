import { computeSourceURL, isAbsolute, normalize, relative } from 'source-map-js/lib/util.js';
import type { SourceMap } from '../types.js';

const base64Digits = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) {
    base64Digits['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;
}

// Generated segments of a source map ordered by generated position, lines and columns are 0-based.
// Segments of generated line L occupy [lineStarts[L], lineStarts[L + 1]).
export class DecodedSourceMap {
    sources: string[];
    sourcesContent: (string | null)[];
    lineStarts: Uint32Array;
    columns: Uint32Array;
    sourceIndexes: Int32Array; // -1 when a segment has no original position
    originalLines: Uint32Array;
    originalColumns: Uint32Array;

    constructor(sourceMap: SourceMap) {
        const { mappings } = sourceMap;
        const sourceRoot = sourceMap.sourceRoot ? normalize(sourceMap.sourceRoot) : null;
        let lineCount = 1;
        let segmentCount = 0;

        for (let i = 0, segmentStarted = false; i < mappings.length; i++) {
            const code = mappings.charCodeAt(i);

            if (code === 59 /* ; */) {
                lineCount++;
                segmentStarted = false;
            } else if (code === 44 /* , */) {
                segmentStarted = false;
            } else if (!segmentStarted) {
                segmentCount++;
                segmentStarted = true;
            }
        }

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
        this.lineStarts = new Uint32Array(lineCount + 1);
        this.columns = new Uint32Array(segmentCount);
        this.sourceIndexes = new Int32Array(segmentCount);
        this.originalLines = new Uint32Array(segmentCount);
        this.originalColumns = new Uint32Array(segmentCount);

        this.#decode(mappings);
    }

    #decode(mappings: string) {
        const { lineStarts, columns, sourceIndexes, originalLines, originalColumns } = this;
        const fields = new Int32Array(5); // column, source, original line, original column, name
        let line = 0;
        let segment = 0;
        let unsortedLine = false;

        for (let i = 0; i < mappings.length;) {
            const code = mappings.charCodeAt(i);

            if (code === 59 /* ; */ || code === 44 /* , */) {
                if (code === 59) {
                    if (unsortedLine) {
                        this.#sortLineSegments(lineStarts[line], segment);
                        unsortedLine = false;
                    }

                    lineStarts[++line] = segment;
                    fields[0] = 0; // generated column is relative to the line start
                }

                i++;
                continue;
            }

            let fieldCount = 0;

            while (i < mappings.length) {
                const segmentCode = mappings.charCodeAt(i);

                if (segmentCode === 59 || segmentCode === 44) {
                    break;
                }

                let value = 0;
                let shift = 0;
                let digit = 0;

                do {
                    const digitCode = mappings.charCodeAt(i++);

                    digit = digitCode < 128 ? base64Digits[digitCode] : -1;

                    if (digit === -1) {
                        throw new Error(`Invalid character in source map mappings at ${i - 1}`);
                    }

                    value |= (digit & 31) << shift;
                    shift += 5;
                } while (digit & 32);

                if (fieldCount < 5) {
                    fields[fieldCount] += value & 1 ? -(value >>> 1) : value >>> 1;
                }

                fieldCount++;
            }

            if (segment > lineStarts[line] && fields[0] < columns[segment - 1]) {
                unsortedLine = true;
            }

            columns[segment] = fields[0];

            if (fieldCount >= 4) {
                sourceIndexes[segment] = fields[1];
                originalLines[segment] = fields[2];
                originalColumns[segment] = fields[3];
            } else {
                // a segment without an original position, also covers malformed 2-3 fields segments
                sourceIndexes[segment] = -1;
            }

            segment++;
        }

        if (unsortedLine) {
            this.#sortLineSegments(lineStarts[line], segment);
        }

        lineStarts.fill(segment, line + 1);
    }

    // Segments are expected to be sorted by generated column within a line, but the spec doesn't require it
    #sortLineSegments(start: number, end: number) {
        const { columns, sourceIndexes, originalLines, originalColumns } = this;
        const order = Array.from({ length: end - start }, (_, index) => start + index)
            .sort((a, b) => columns[a] - columns[b]);
        const lineColumns = columns.slice(start, end);
        const lineSourceIndexes = sourceIndexes.slice(start, end);
        const lineOriginalLines = originalLines.slice(start, end);
        const lineOriginalColumns = originalColumns.slice(start, end);

        for (let i = 0; i < order.length; i++) {
            const from = order[i] - start;

            columns[start + i] = lineColumns[from];
            sourceIndexes[start + i] = lineSourceIndexes[from];
            originalLines[start + i] = lineOriginalLines[from];
            originalColumns[start + i] = lineOriginalColumns[from];
        }
    }

    // Returns the segment covering a generated position, i.e. the first of the rightmost segments
    // starting at or before the column on the same line, or -1 when there is no such segment
    findSegment(line: number, column: number) {
        const { lineStarts, columns } = this;

        if (line < 0 || line >= lineStarts.length - 1) {
            return -1;
        }

        let low = lineStarts[line];
        let high = lineStarts[line + 1] - 1;
        let segment = -1;

        while (low <= high) {
            const mid = (low + high) >>> 1;

            if (columns[mid] <= column) {
                segment = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        while (segment > lineStarts[line] && columns[segment - 1] === columns[segment]) {
            segment--;
        }

        return segment;
    }
}
