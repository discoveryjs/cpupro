import type { EventClasses } from './population-filter.js';

// Parts follow a grid of bins on the population's own value axis, so ranges on that grid cover whole parts;
// bins with many events are split, so a range edge inside one costs a bounded number of events
const GRID_BIN_COUNT = 2000;
const MAX_PART_EVENTS = 1 << 16;

type EventValues = Uint8Array | Uint16Array | Uint32Array;

/**
 * Events of a base population grouped by sample and event class (a key) within parts of consecutive events
 * (bins of a grid on the population's value axis). A derived population that accepts events by sample and by
 * event class keeps the sum of the records of the parts its ranges cover (RecordsAggregate) and computes
 * per-sample metrics from keys instead of events.
 */
export class PopulationRecords {
    readonly eventCount: number;
    readonly partEvents: Uint32Array;     // per part: its first event, plus the end of the last part
    readonly partStarts: Uint32Array;     // per part: its first record, plus the end of the last part
    readonly recordKeys: Uint32Array;     // per record
    readonly recordWeights: Float64Array; // per record: sum of event values
    readonly recordCounts: Uint32Array;   // per record: number of events with a nonzero value
    readonly keySamples: Uint32Array;     // per key
    readonly keyClasses: Uint32Array;     // per key

    constructor(
        readonly samples: Uint32Array,
        readonly values: Uint32Array,
        cumulative: Float64Array,
        cumulativeEnd: number,
        readonly classes: EventClasses
    ) {
        const partEvents = splitParts(cumulative, cumulativeEnd);
        const grouped = groupParts(samples, values, classes.ids, partEvents);

        this.eventCount = samples.length;
        this.partEvents = partEvents;
        this.partStarts = grouped.partStarts;
        this.recordKeys = grouped.recordKeys;
        this.recordWeights = grouped.recordWeights;
        this.recordCounts = grouped.recordCounts;
        this.keySamples = grouped.keySamples;
        this.keyClasses = grouped.keyClasses;
    }

    get partCount() {
        return this.partStarts.length - 1;
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

    get keyCount() {
        return this.keySamples.length;
    }

    // Event acceptance over these values is constant within an event class
    classifies(values: EventValues) {
        const { classes } = this;

        return values === classes.ids || classes.values.has(values);
    }
}

/**
 * Sums of the records of whole parts covered by event intervals, kept per key and updated by the parts
 * whose coverage changes. Events of partially covered parts are kept as intervals for per-event aggregation.
 */
export class RecordsAggregate {
    readonly weights: Float64Array;   // per key
    readonly counts: Float64Array;    // per key
    readonly #parts: Uint8Array;      // per part: 1 when wholly covered
    partialIntervals: [number, number][] = [];
    count = 0;                        // sum of counts

    constructor(readonly records: PopulationRecords) {
        this.weights = new Float64Array(records.keyCount);
        this.counts = new Float64Array(records.keyCount);
        this.#parts = new Uint8Array(records.partCount);
    }

    // Covers events of normalized, ordered, disjoint intervals [start, end)
    cover(intervals: readonly [number, number][]) {
        const { records } = this;
        const { partEvents, partCount } = records;
        const covered = new Uint8Array(partCount);
        const partial: [number, number][] = [];

        for (const [start, end] of intervals) {
            if (start >= end) {
                continue;
            }

            const startPart = records.partOf(start);
            const lastPart = records.partOf(end - 1);
            const firstPart = partEvents[startPart] === start ? startPart : startPart + 1;
            const endPart = partEvents[lastPart + 1] === end ? lastPart + 1 : lastPart;

            if (firstPart >= endPart) {
                partial.push([start, end]);
                continue;
            }

            covered.fill(1, firstPart, endPart);

            if (start < partEvents[firstPart]) {
                partial.push([start, partEvents[firstPart]]);
            }

            if (partEvents[endPart] < end) {
                partial.push([partEvents[endPart], end]);
            }
        }

        for (let part = 0; part < partCount; part++) {
            if (covered[part] !== this.#parts[part]) {
                this.#addPart(part, covered[part] === 1 ? 1 : -1);
                this.#parts[part] = covered[part];
            }
        }

        this.partialIntervals = partial;
    }

    #addPart(part: number, sign: number) {
        const { partStarts, recordKeys, recordWeights, recordCounts } = this.records;
        const { weights, counts } = this;

        for (let record = partStarts[part]; record < partStarts[part + 1]; record++) {
            const key = recordKeys[record];

            weights[key] += sign * recordWeights[record];
            counts[key] += sign * recordCounts[record];
            this.count += sign * recordCounts[record];
        }
    }
}

function hashKey(sample: number, eventClass: number) {
    return (Math.imul(sample, 0x9e3779b1) ^ Math.imul(eventClass + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
}

// Starts of parts of events, plus the end of the last part: bins of a grid on the value axis, empty bins
// dropped and bins with many events split
function splitParts(cumulative: Float64Array, cumulativeEnd: number) {
    const eventCount = cumulative.length;
    const starts = [0];

    for (let bin = 1; bin <= GRID_BIN_COUNT; bin++) {
        const end = bin === GRID_BIN_COUNT
            ? eventCount
            : findCumulativeBoundary(cumulative, cumulativeEnd * bin / GRID_BIN_COUNT);
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

// A part-local hash table finds the record of an event in its part; a global one assigns key IDs
// only to the first event of a record. Consecutive events often share a key and skip both.
function groupParts(samples: Uint32Array, values: Uint32Array, classIds: EventValues, partEvents: Uint32Array) {
    const eventCount = samples.length;
    const partCount = partEvents.length - 1;
    const partStarts = new Uint32Array(partCount + 1);
    // PERF: Tables and growing arrays start at the size of the population, so small ones allocate little
    let maxPartEvents = 0;

    for (let part = 0; part < partCount; part++) {
        maxPartEvents = Math.max(maxPartEvents, partEvents[part + 1] - partEvents[part]);
    }

    const partSlots = new Int32Array(capacity(2 * maxPartEvents)).fill(-1);
    const partMask = partSlots.length - 1;
    const usedPartSlots = new Uint32Array(maxPartEvents);
    // PERF: Keys are typically a few per sample and class; sizing for that avoids rehashing large tables
    let keySlots = new Int32Array(capacity(Math.min(eventCount, 1 << 22))).fill(-1);
    let keySamples = new Uint32Array(capacity(Math.min(eventCount, 1 << 16)));
    let keyClasses = new Uint32Array(keySamples.length);
    let keyCount = 0;
    let recordKeys = new Uint32Array(capacity(Math.min(eventCount, 1 << 20)));
    let recordWeights = new Float64Array(recordKeys.length);
    let recordCounts = new Uint32Array(recordKeys.length);
    let recordCount = 0;

    const growKeySlots = () => {
        const mask = keySlots.length * 2 - 1;

        keySlots = new Int32Array(keySlots.length * 2).fill(-1);

        for (let key = 0; key < keyCount; key++) {
            let slot = hashKey(keySamples[key], keyClasses[key]) & mask;

            while (keySlots[slot] !== -1) {
                slot = (slot + 1) & mask;
            }

            keySlots[slot] = key;
        }
    };

    const findKey = (sample: number, eventClass: number, hash: number) => {
        const mask = keySlots.length - 1;
        let slot = hash & mask;

        while (keySlots[slot] !== -1) {
            const key = keySlots[slot];

            if (keySamples[key] === sample && keyClasses[key] === eventClass) {
                return key;
            }

            slot = (slot + 1) & mask;
        }

        if (keyCount === keySamples.length) {
            keySamples = grow(keySamples);
            keyClasses = grow(keyClasses);
        }

        keySamples[keyCount] = sample;
        keyClasses[keyCount] = eventClass;
        keySlots[slot] = keyCount;

        if (2 * ++keyCount > keySlots.length) {
            growKeySlots();
        }

        return keyCount - 1;
    };

    for (let part = 0; part < partCount; part++) {
        const end = partEvents[part + 1];
        let usedSlots = 0;
        let previousSample = -1;
        let previousClass = -1;
        let previousRecord = 0;

        partStarts[part] = recordCount;

        for (let event = partEvents[part]; event < end; event++) {
            const sample = samples[event];
            const eventClass = classIds[event];

            if (sample !== previousSample || eventClass !== previousClass) {
                const hash = hashKey(sample, eventClass);
                let slot = hash & partMask;

                // A slot keeps a record of the part
                while (partSlots[slot] !== -1) {
                    const key = recordKeys[partSlots[slot]];

                    if (keySamples[key] === sample && keyClasses[key] === eventClass) {
                        break;
                    }

                    slot = (slot + 1) & partMask;
                }

                if (partSlots[slot] === -1) {
                    if (recordCount === recordKeys.length) {
                        recordKeys = grow(recordKeys);
                        recordWeights = grow(recordWeights);
                        recordCounts = grow(recordCounts);
                    }

                    partSlots[slot] = recordCount;
                    usedPartSlots[usedSlots++] = slot;
                    recordKeys[recordCount] = findKey(sample, eventClass, hash);
                    recordWeights[recordCount] = 0;
                    recordCounts[recordCount] = 0;
                    recordCount++;
                }

                previousSample = sample;
                previousClass = eventClass;
                previousRecord = partSlots[slot];
            }

            const value = values[event];

            recordWeights[previousRecord] += value;
            recordCounts[previousRecord] += value !== 0 ? 1 : 0;
        }

        for (let index = 0; index < usedSlots; index++) {
            partSlots[usedPartSlots[index]] = -1;
        }
    }

    partStarts[partCount] = recordCount;

    return {
        partStarts,
        recordKeys: recordKeys.slice(0, recordCount),
        recordWeights: recordWeights.slice(0, recordCount),
        recordCounts: recordCounts.slice(0, recordCount),
        keySamples: keySamples.slice(0, keyCount),
        keyClasses: keyClasses.slice(0, keyCount)
    };
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
