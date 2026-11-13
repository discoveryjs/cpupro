import type { EventClasses } from './population-filter.js';
import { createRecordsBuffer, recordsApiOf, type RecordsBuffer } from './population-records.compute.js';

// Parts follow a grid of bins on the population's own value axis, so ranges on that grid cover whole parts;
// bins with many events are split, so a range edge inside one costs a bounded number of events
const GRID_BIN_COUNT = 2000;
const MAX_PART_EVENTS = 1 << 16;
// A part whose runs of one sample average this many events leads the next part to group by class within runs
const MIN_SAMPLE_RUN = 32;
// Records of parts are kept in blocks of this many records, since their count is known only after grouping
const BLOCK_RECORDS = 1 << 20;

type EventValues = Uint8Array | Uint16Array | Uint32Array;
// Records of consecutive parts: a part's records are in one block
type RecordsBlock = {
    samples: Uint32Array;
    classes: Uint32Array;
    weights: Float64Array; // per record: sum of event values
    counts: Uint32Array;   // per record: number of events with a nonzero value
};
export type RecordSums = {
    sampleTotals: Float64Array;
    sampleCounts: Uint32Array;
    classTotals: Float64Array;
    classCounts: Uint32Array;
};

// Events of a base population summed by sample and event class within parts of consecutive events (bins of a grid
// on the population's value axis). A derived population that accepts events by sample and by event class sums
// the records of the parts its ranges cover instead of their events.
export class PopulationRecords {
    readonly partEvents: Uint32Array;  // per part: its first event, plus the end of the last part
    readonly partRecords: Uint32Array; // per part: its first record, plus the end of the last part
    readonly partCounts: Uint32Array;  // per part: number of events with a nonzero value
    // A record numbered n is at n % blockSize in block n / blockSize; a block ends at its last part's records
    readonly blocks: readonly RecordsBlock[];
    readonly blockSize: number;

    constructor(
        readonly samples: Uint32Array,
        readonly values: Uint32Array,
        cumulative: Float64Array,
        cumulativeEnd: number,
        readonly classes: EventClasses
    ) {
        const partEvents = splitParts(cumulative, cumulativeEnd);
        const records = groupParts(samples, values, classes.ids, classes.events.length, partEvents);

        this.partEvents = partEvents;
        this.partRecords = records.partRecords;
        this.partCounts = records.partCounts;
        this.blocks = records.blocks;
        this.blockSize = records.blockSize;
    }

    get partCount() {
        return this.partEvents.length - 1;
    }

    // Index of the part containing an event
    partOf(event: number) {
        const { partEvents } = this;
        let left = 0;
        let right = partEvents.length - 2;

        while (left < right) {
            const middle = (left + right + 1) >>> 1;

            if (partEvents[middle] <= event) {
                left = middle;
            } else {
                right = middle - 1;
            }
        }

        return left;
    }

    // Whole parts [start, end) and events of partially covered parts [start, end) of normalized, ordered,
    // disjoint event intervals
    cover(intervals: readonly [number, number][]) {
        const { partEvents } = this;
        const parts: [number, number][] = [];
        const events: [number, number][] = [];

        for (let i = 0; i < intervals.length; i++) {
            const [start, end] = intervals[i];

            if (start >= end) {
                continue;
            }

            const startPart = this.partOf(start);
            const lastPart = this.partOf(end - 1);
            const firstPart = partEvents[startPart] === start ? startPart : startPart + 1;
            const endPart = partEvents[lastPart + 1] === end ? lastPart + 1 : lastPart;

            if (firstPart >= endPart) {
                events.push([start, end]);
                continue;
            }

            parts.push([firstPart, endPart]);

            if (start < partEvents[firstPart]) {
                events.push([start, partEvents[firstPart]]);
            }

            if (partEvents[endPart] < end) {
                events.push([partEvents[endPart], end]);
            }
        }

        return { parts, events };
    }

    // Adds the records of whole parts to their samples and event classes when both are accepted, to the entry
    // after the samples (the sink) otherwise
    sum(parts: [number, number][], sampleAccepts: Uint8Array, classAccepts: Uint8Array, sums: RecordSums) {
        const { partRecords, blocks, blockSize } = this;
        const { sampleTotals, sampleCounts, classTotals, classCounts } = sums;
        const rejected = sampleAccepts.length;

        for (let i = 0; i < parts.length; i++) {
            const [startPart, endPart] = parts[i];
            const end = partRecords[endPart];

            let first = partRecords[startPart];

            // Records of the parts run through consecutive blocks
            while (first < end) {
                const block = Math.floor(first / blockSize);
                const blockStart = block * blockSize;
                const { samples, classes, weights, counts } = blocks[block];
                const last = Math.min(samples.length, end - blockStart);

                for (let j = first - blockStart; j < last; j++) {
                    const sample = samples[j];
                    const eventClass = classes[j];
                    const weight = weights[j];
                    const count = counts[j];

                    if ((sampleAccepts[sample] & classAccepts[eventClass]) === 1) {
                        sampleTotals[sample] += weight;
                        sampleCounts[sample] += count;
                        classTotals[eventClass] += weight;
                        classCounts[eventClass] += count;
                    } else {
                        sampleTotals[rejected] += weight;
                        sampleCounts[rejected] += count;
                    }
                }

                first = blockStart + blockSize;
            }
        }
    }

    // Number of events with a nonzero value in the records of whole parts whose sample and event class are accepted
    count(parts: [number, number][], sampleAccepts: Uint8Array, classAccepts: Uint8Array) {
        const { partRecords, blocks, blockSize } = this;
        let count = 0;

        for (let i = 0; i < parts.length; i++) {
            const [startPart, endPart] = parts[i];
            const end = partRecords[endPart];

            let first = partRecords[startPart];

            // Records of the parts run through consecutive blocks
            while (first < end) {
                const block = Math.floor(first / blockSize);
                const blockStart = block * blockSize;
                const { samples, classes, counts } = blocks[block];
                const last = Math.min(samples.length, end - blockStart);

                for (let j = first - blockStart; j < last; j++) {
                    if ((sampleAccepts[samples[j]] & classAccepts[classes[j]]) === 1) {
                        count += counts[j];
                    }
                }

                first = blockStart + blockSize;
            }
        }

        return count;
    }

    // Event acceptance over these values is constant within an event class
    classifies(values: EventValues) {
        const { classes } = this;

        return values === classes.ids || classes.values.has(values);
    }

    // Value of every event class for event values that the event classes classify
    classValues(values: EventValues) {
        const { events } = this.classes;
        const classValues = new Uint32Array(events.length);

        for (let i = 0; i < events.length; i++) {
            classValues[i] = values[events[i]];
        }

        return classValues;
    }
}

// Starts of parts of events, plus the end of the last part: bins of a grid on the value axis, empty bins
// dropped and bins with many events split
function splitParts(cumulative: Float64Array, cumulativeEnd: number) {
    const eventCount = cumulative.length;
    const starts = [0];

    for (let i = 1; i <= GRID_BIN_COUNT; i++) {
        const end = i === GRID_BIN_COUNT
            ? eventCount
            : findCumulativeBoundary(cumulative, cumulativeEnd * i / GRID_BIN_COUNT);
        let start = starts[starts.length - 1];

        while (end - start > MAX_PART_EVENTS) {
            start += MAX_PART_EVENTS;
            starts.push(start);
        }

        if (end > start) {
            starts.push(end);
        }
    }

    return Uint32Array.from(starts);
}

// First event with a coordinate at or after the value
function findCumulativeBoundary(cumulative: Float64Array, value: number) {
    let left = 0;
    let right = cumulative.length;

    while (left < right) {
        const middle = (left + right) >>> 1;

        if (cumulative[middle] < value) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    return left;
}

// A record sums the events of a sample and a class in a part. Records are numbered in the order of parts, so table
// entries holding records of earlier parts are free and the tables need no clearing.
function groupParts(
    samples: Uint32Array,
    values: Uint32Array,
    classIds: EventValues,
    classCount: number,
    partEvents: Uint32Array
) {
    const partCount = partEvents.length - 1;
    const records = new RecordsBuilder(samples.length, partCount);
    let maxPartEvents = 0;

    for (let i = 0; i < partCount; i++) {
        maxPartEvents = Math.max(maxPartEvents, partEvents[i + 1] - partEvents[i]);
    }

    const buffer = createRecordsBuffer(maxPartEvents, classCount, classIds);
    const api = recordsApiOf(buffer);
    let byRuns = false;

    // PERF: Allocations of a CPU sample come in runs of one sample, where a dense table finds a record by class
    // without hashing. A part takes the lookup that fits the runs of the part before it, counted while grouping.
    // Events of a part are staged into the buffer and its records are copied out to their block
    for (let i = 0; i < partCount; i++) {
        const start = partEvents[i];
        const end = partEvents[i + 1];
        const firstRecord = records.startPart(end - start);

        buffer.samples.set(samples.subarray(start, end));
        buffer.values.set(values.subarray(start, end));
        buffer.classes.set(classIds.subarray(start, end));

        const recordCount = byRuns
            ? api.groupRuns(buffer, end - start, firstRecord)
            : api.groupPairs(buffer, end - start, firstRecord);

        records.endPart(buffer, recordCount);
        byRuns = end - start >= MIN_SAMPLE_RUN * buffer.runs[0];
    }

    return records.finish();
}

// Records of parts in the order of parts. A part has at most as many records as events, so its records go to the rest
// of the current block, or start the next one: the count of records needs no bound in advance
class RecordsBuilder {
    count = 0; // number of the next record
    parts = 0;
    readonly blocks: RecordsBlock[] = [];
    readonly blockSize: number;
    readonly partRecords: Uint32Array;
    readonly partCounts: Uint32Array;
    #block: RecordsBlock | null = null;
    #blockCount = 0;

    constructor(eventCount: number, partCount: number) {
        // PERF: Blocks are bounded by the population's size, so small ones allocate little
        this.blockSize = Math.max(1, Math.min(eventCount, BLOCK_RECORDS));
        this.partRecords = new Uint32Array(partCount + 1);
        this.partCounts = new Uint32Array(partCount);
    }

    // Starts the records of a part of a number of events; returns the number of its first record
    startPart(eventCount: number) {
        let block = this.#block;

        if (block === null || this.#blockCount + eventCount > this.blockSize) {
            // A full block ends at its records: the room after them is less than a part
            if (block !== null) {
                this.blocks.push({
                    samples: block.samples.subarray(0, this.#blockCount),
                    classes: block.classes.subarray(0, this.#blockCount),
                    weights: block.weights.subarray(0, this.#blockCount),
                    counts: block.counts.subarray(0, this.#blockCount)
                });
            }

            block = {
                samples: new Uint32Array(this.blockSize),
                classes: new Uint32Array(this.blockSize),
                weights: new Float64Array(this.blockSize),
                counts: new Uint32Array(this.blockSize)
            };
            this.#block = block;
            this.#blockCount = 0;
            this.count = this.blocks.length * this.blockSize;
        }

        this.partRecords[this.parts] = this.count;

        return this.count;
    }

    // Ends the current part with its records grouped in a buffer, copied to the rest of the block
    endPart(buffer: RecordsBuffer, recordCount: number) {
        const block = this.#block!;
        const offset = this.#blockCount;

        block.samples.set(buffer.recordSamples.subarray(0, recordCount), offset);
        block.classes.set(buffer.recordClasses.subarray(0, recordCount), offset);
        block.weights.set(buffer.recordWeights.subarray(0, recordCount), offset);
        block.counts.set(buffer.recordCounts.subarray(0, recordCount), offset);
        this.#blockCount += recordCount;
        this.count += recordCount;
        this.partCounts[this.parts] = buffer.nonzero[0];
        this.parts++;
    }

    finish() {
        const block = this.#block;
        const count = this.#blockCount;

        // The last block keeps only its records
        if (block !== null) {
            this.blocks.push({
                samples: block.samples.slice(0, count),
                classes: block.classes.slice(0, count),
                weights: block.weights.slice(0, count),
                counts: block.counts.slice(0, count)
            });
        }

        this.partRecords[this.partCounts.length] = this.count;

        return {
            partRecords: this.partRecords,
            partCounts: this.partCounts,
            blocks: this.blocks,
            blockSize: this.blockSize
        };
    }
}
