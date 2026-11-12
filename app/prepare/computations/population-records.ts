import type { EventClasses } from './population-filter.js';

// Parts follow a grid of bins on the population's own value axis, so ranges on that grid cover whole parts;
// bins with many events are split, so a range edge inside one costs a bounded number of events
const GRID_BIN_COUNT = 2000;
const MAX_PART_EVENTS = 1 << 16;
// A part whose runs of one sample average this many events leads the next part to group by class within runs
const MIN_SAMPLE_RUN = 32;

type EventValues = Uint8Array | Uint16Array | Uint32Array;
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
    readonly partEvents: Uint32Array;     // per part: its first event, plus the end of the last part
    readonly partRecords: Uint32Array;    // per part: its first record, plus the end of the last part
    readonly partCounts: Uint32Array;     // per part: number of events with a nonzero value
    readonly recordSamples: Uint32Array;  // per record
    readonly recordClasses: Uint32Array;  // per record
    readonly recordWeights: Float64Array; // per record: sum of event values
    readonly recordCounts: Uint32Array;   // per record: number of events with a nonzero value

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
        this.recordSamples = records.recordSamples;
        this.recordClasses = records.recordClasses;
        this.recordWeights = records.recordWeights;
        this.recordCounts = records.recordCounts;
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
        const { partRecords, recordSamples, recordClasses, recordWeights, recordCounts } = this;
        const { sampleTotals, sampleCounts, classTotals, classCounts } = sums;
        const rejected = sampleAccepts.length;

        for (let i = 0; i < parts.length; i++) {
            const [startPart, endPart] = parts[i];
            const end = partRecords[endPart];

            for (let j = partRecords[startPart]; j < end; j++) {
                const sample = recordSamples[j];
                const eventClass = recordClasses[j];
                const weight = recordWeights[j];
                const count = recordCounts[j];

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
        }
    }

    // Event acceptance over these values is constant within an event class
    classifies(values: EventValues) {
        const { classes } = this;

        return values === classes.ids || classes.values.has(values);
    }

    // Value of every event class for event values that the event classes classify
    classValues(values: EventValues) {
        return Uint32Array.from(this.classes.events, event => values[event]);
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

    const slots = new Int32Array(capacity(2 * maxPartEvents)).fill(-1);
    const classRecords = new Int32Array(classCount).fill(-1);
    let byRuns = false;

    // PERF: Allocations of a CPU sample come in runs of one sample, where a dense table finds a record by class
    // without hashing. A part takes the lookup that fits the runs of the part before it, counted while grouping,
    // and each lookup has a loop of its own
    for (let i = 0; i < partCount; i++) {
        const start = partEvents[i];
        const end = partEvents[i + 1];
        const runs = byRuns
            ? groupRuns(records, classRecords, samples, values, classIds, start, end)
            : groupPairs(records, slots, samples, values, classIds, start, end);

        byRuns = end - start >= MIN_SAMPLE_RUN * runs;
    }

    return records.finish();
}

// A hash table finds the record of an event's sample and class in the part. Consecutive events often share
// a sample and a class and skip the lookup. Returns the number of runs of one sample in the part
function groupPairs(
    records: RecordsBuilder,
    slots: Int32Array,
    samples: Uint32Array,
    values: Uint32Array,
    classIds: EventValues,
    start: number,
    end: number
) {
    const slotMask = slots.length - 1;
    const firstRecord = records.count;
    // PERF: Vectors of records are read in the loop as locals, taken again when adding a record may grow them
    let recordSamples = records.samples;
    let recordClasses = records.classes;
    let recordWeights = records.weights;
    let recordCounts = records.counts;
    let previousSample = -1;
    let previousClass = -1;
    let record = 0;
    let runs = 0;
    let count = 0;

    for (let i = start; i < end; i++) {
        const sample = samples[i];
        const eventClass = classIds[i];
        const value = values[i];

        if (sample !== previousSample || eventClass !== previousClass) {
            let slot = hashKey(sample, eventClass) & slotMask;

            record = slots[slot];

            while (record >= firstRecord) {
                if (recordSamples[record] === sample && recordClasses[record] === eventClass) {
                    break;
                }

                slot = (slot + 1) & slotMask;
                record = slots[slot];
            }

            if (record < firstRecord) {
                record = records.add(sample, eventClass);
                slots[slot] = record;
                recordSamples = records.samples;
                recordClasses = records.classes;
                recordWeights = records.weights;
                recordCounts = records.counts;
            }

            if (sample !== previousSample) {
                runs++;
            }

            previousSample = sample;
            previousClass = eventClass;
        }

        if (value !== 0) {
            recordWeights[record] += value;
            recordCounts[record]++;
            count++;
        }
    }

    records.endPart(firstRecord, count);

    return runs;
}

// Events of a run of one sample find their record by class through a dense table, which takes a record of the run
// as one of the sample: a sample recurring in the part takes records of its own for every run. Returns the number
// of runs in the part
function groupRuns(
    records: RecordsBuilder,
    classRecords: Int32Array,
    samples: Uint32Array,
    values: Uint32Array,
    classIds: EventValues,
    start: number,
    end: number
) {
    const firstRecord = records.count;
    // PERF: Vectors of records are read in the loop as locals, taken again when adding a record may grow them
    let recordWeights = records.weights;
    let recordCounts = records.counts;
    let runFirstRecord = firstRecord;
    let previousSample = -1;
    let runs = 0;
    let count = 0;

    for (let i = start; i < end; i++) {
        const sample = samples[i];
        const eventClass = classIds[i];
        const value = values[i];

        if (sample !== previousSample) {
            runFirstRecord = records.count;
            previousSample = sample;
            runs++;
        }

        let record = classRecords[eventClass];

        if (record < runFirstRecord) {
            record = records.add(sample, eventClass);
            classRecords[eventClass] = record;
            recordWeights = records.weights;
            recordCounts = records.counts;
        }

        if (value !== 0) {
            recordWeights[record] += value;
            recordCounts[record]++;
            count++;
        }
    }

    records.endPart(firstRecord, count);

    return runs;
}

// Records of parts in the order of parts
class RecordsBuilder {
    count = 0;
    parts = 0;
    samples: Uint32Array;
    classes: Uint32Array;
    weights: Float64Array;
    counts: Uint32Array;
    readonly partRecords: Uint32Array;
    readonly partCounts: Uint32Array;

    constructor(eventCount: number, partCount: number) {
        // PERF: Records grow from a size bounded by the population's, so small ones allocate little
        const size = capacity(Math.min(eventCount, 1 << 20));

        this.samples = new Uint32Array(size);
        this.classes = new Uint32Array(size);
        this.weights = new Float64Array(size);
        this.counts = new Uint32Array(size);
        this.partRecords = new Uint32Array(partCount + 1);
        this.partCounts = new Uint32Array(partCount);
    }

    add(sample: number, eventClass: number) {
        if (this.count === this.samples.length) {
            this.samples = grow(this.samples);
            this.classes = grow(this.classes);
            this.weights = grow(this.weights);
            this.counts = grow(this.counts);
        }

        const record = this.count++;

        this.samples[record] = sample;
        this.classes[record] = eventClass;

        return record;
    }

    endPart(firstRecord: number, count: number) {
        this.partRecords[this.parts] = firstRecord;
        this.partCounts[this.parts] = count;
        this.parts++;
    }

    finish() {
        this.partRecords[this.partCounts.length] = this.count;

        return {
            partRecords: this.partRecords,
            partCounts: this.partCounts,
            recordSamples: this.samples.slice(0, this.count),
            recordClasses: this.classes.slice(0, this.count),
            recordWeights: this.weights.slice(0, this.count),
            recordCounts: this.counts.slice(0, this.count)
        };
    }
}

function hashKey(sample: number, eventClass: number) {
    return (Math.imul(sample, 0x9e3779b1) ^ Math.imul(eventClass + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
}

// Power of two size of a table or a growing array, at least 16
function capacity(size: number) {
    return 2 ** Math.ceil(Math.log2(Math.max(16, size)));
}

function grow<T extends Uint32Array | Float64Array>(array: T): T {
    const grown = new (array.constructor as new (length: number) => T)(array.length * 2);

    grown.set(array);

    return grown;
}
