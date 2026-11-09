import type { PopulationFiltered } from '../computations/population.js';
import type { EventClasses } from '../computations/population-filter.js';
import type { PreparedAttributeFilter } from '../computations/attribute-filter.js';
import { equalRanges, type RangeSet } from '../computations/coordinates.js';
import { lowerBound } from '../computations/misc.js';
import type { ProfileLine, ProfileLineAttribute } from './types.js';

// Identity-like attributes have about as many values as there are signatures; grouping by them would
// multiply signatures and records for every aggregation, so their own consumers aggregate events directly
const IDENTITY_ATTRIBUTES = new Set<ProfileLineAttribute['name']>(['allocationOwner']);
const CHUNK_LENGTH = 1 << 16;
// Windows with up to this many events take their records from events, a pass of about 2 ms
const WINDOW_EVENTS = 1 << 20;
// Bins of a window's data grid
const WINDOW_BINS = 2000;

type SignatureColumn = {
    values: Uint8Array | Uint16Array | Uint32Array;
    // Base population samples when values are given per sample, null when values are given per event
    samples: Uint32Array | null;
    // Values of a registered event filter
    filtered: boolean;
};

export type BinRecordsGrid = {
    total: number;
    step: number;
    skip: number;
    ranges: RangeSet | null;
    axisRanges: RangeSet | null;
};

/**
 * Signatures of line events: the combination of values that aggregations and filters distinguish, without
 * the event's value. Events of one signature have equal values of every attribute (except identity-like ones),
 * equal category nodes in every breakdown and equal values of every registered filter partition, so they are
 * accepted or rejected together and fall into the same track of every histogram.
 */
export class EventSignatures {
    readonly ids: Uint16Array | Uint32Array; // per event
    readonly events: Uint32Array;  // per signature: its first event
    readonly #columns: SignatureColumn[];
    readonly #signatureValues = new Map<SignatureColumn['values'], Uint32Array>();
    readonly #binRecords = new Map<string, BinRecords>();
    // Per mapping or cumulative vector of the line's events
    readonly #rangeRecords = new Map<Uint32Array | Float64Array, RangeRecords | null>();
    // Per weights vector of the line's events
    readonly #totals = new Map<Uint32Array, Float64Array>();
    #filterClasses: EventClasses | null = null;

    constructor(line: ProfileLine) {
        const columns = collectSignatureColumns(line);
        const { ids, events } = assignSignatures(line.values.length, keyColumns(columns));

        this.ids = ids;
        this.events = events;
        this.#columns = columns;

        // Events of a signature share the values of every column, so its first event gives them
        for (const { values: columnValues, samples } of columns) {
            const values = new Uint32Array(events.length);

            for (let signature = 0; signature < values.length; signature++) {
                const event = events[signature];

                values[signature] = columnValues[samples === null ? event : samples[event]];
            }

            this.#signatureValues.set(columnValues, values);
        }
    }

    get count() {
        return this.events.length;
    }

    // Classes of events with equal values of every registered event filter: such filters accept or reject
    // the events of a class together. Each signature belongs to one class, so classes group signatures.
    get filterClasses(): EventClasses {
        return this.#filterClasses ??= this.#groupFilterClasses();
    }

    #groupFilterClasses(): EventClasses {
        const columns = this.#columns.filter(column => column.filtered);
        const columnValues = columns.map(column => this.#signatureValues.get(column.values)!);
        const classIds = new Map<string, number>();
        const signatureClasses = new Uint32Array(this.count);
        const events: number[] = [];

        // Signatures are numbered in the order of their first events, so a class's first signature gives its first event
        for (let signature = 0; signature < this.count; signature++) {
            const key = columnValues.map(values => values[signature]).join(',');
            let classId = classIds.get(key);

            if (classId === undefined) {
                classId = events.push(this.events[signature]) - 1;
                classIds.set(key, classId);
            }

            signatureClasses[signature] = classId;
        }

        const ids = events.length <= 0x100
            ? new Uint8Array(this.ids.length)
            : events.length <= 0x10000
                ? new Uint16Array(this.ids.length)
                : new Uint32Array(this.ids.length);

        for (let event = 0; event < ids.length; event++) {
            ids[event] = signatureClasses[this.ids[event]];
        }

        return {
            ids,
            events: Uint32Array.from(events),
            values: new Set(columns.map(column => column.values))
        };
    }

    // Value of every signature for an attribute or a breakdown's sample-to-category-node mapping
    valuesOf(values: SignatureColumn['values']) {
        return this.#signatureValues.get(values) ?? null;
    }

    // Weight of the events of every signature over the whole line, computed on the first use and kept,
    // since neither the events nor their signatures change
    totals(weights: Uint32Array) {
        let totals = this.#totals.get(weights);

        if (totals === undefined) {
            const { ids } = this;

            totals = new Float64Array(this.count);

            for (let event = 0; event < ids.length; event++) {
                totals[ids[event]] += weights[event];
            }

            this.#totals.set(weights, totals);
        }

        return totals;
    }

    // Acceptance of every signature by a population of the line, or null when the population may accept
    // events of one signature differently: a raw mask, index/value constraints or a filter over other values
    acceptance(population: PopulationFiltered) {
        if (population.source !== population.population || !population.acceptsByFilters) {
            return null;
        }

        for (const filter of population.filter.filters) {
            if (filter.accepts !== null && !this.#distinguishes(filter, population.population.samples)) {
                return null;
            }
        }

        const { sinkId } = population;
        const { destination } = population.eventReader();
        const { events } = this;
        const accepted = new Uint8Array(events.length);

        for (let signature = 0; signature < events.length; signature++) {
            accepted[signature] = destination(events[signature]) !== sinkId ? 1 : 0;
        }

        return accepted;
    }

    // Records of one binning grid; replaced when the grid changes (a window or bin count change). Records of a
    // grid over unrestricted populations, the whole extent where zooming out returns, are kept apart from the
    // records of a window
    binRecords(key: string, grid: BinRecordsGrid) {
        if (grid.ranges === null && grid.axisRanges === null) {
            key += ':unrestricted';
        }

        const records = this.#binRecords.get(key);

        if (records !== undefined && records.matches(grid)) {
            return records;
        }

        const created = new BinRecords(grid, this.count);

        this.#binRecords.set(key, created);

        return created;
    }

    // Records of the events of every target in another line, for a nondecreasing mapping
    targetRecords(mapping: Uint32Array, targetCount: number, weights: Uint32Array) {
        return this.#ranges(mapping, () => new RangeRecords(this, targetStarts(mapping, targetCount), weights))!;
    }

    // Records of the cells of a fine grid on the line's own axis: WINDOW_BINS cells per window of the deepest
    // window level whose windows average more than WINDOW_EVENTS events, so bins of windows of that and coarser
    // levels hold whole cells for bin counts dividing WINDOW_BINS times a power of two; deeper windows have few
    // events. Null when the line has few events.
    cellRecords(cumulative: Float64Array, cumulativeEnd: number, weights: Uint32Array, windowEvents = WINDOW_EVENTS) {
        return this.#ranges(cumulative, () => {
            if (cumulative.length <= windowEvents || cumulativeEnd === 0) {
                return null;
            }

            const level = Math.ceil(Math.log2(cumulative.length / windowEvents)) - 1;

            return new RangeRecords(this, cellStarts(cumulative, cumulativeEnd, WINDOW_BINS * 2 ** level), weights);
        });
    }

    // Range records are built on the first aggregation that uses them and kept with the signatures, since
    // neither the events nor their signatures change
    #ranges(events: Uint32Array | Float64Array, create: () => RangeRecords | null) {
        if (!this.#rangeRecords.has(events)) {
            this.#rangeRecords.set(events, create());
        }

        return this.#rangeRecords.get(events)!;
    }

    #distinguishes(filter: PreparedAttributeFilter, baseSamples: Uint32Array) {
        const samples = filter.domain === 'sample' ? baseSamples : null;

        return filter.values !== undefined &&
            this.#columns.some(column => column.values === filter.values && column.samples === samples);
    }
}

/**
 * Events of a line grouped by consecutive ranges of events and by signature. A grid span holding whole ranges takes
 * their records instead of their events: ranges of the events of one target, for grids on the target line's axis
 * (they place targets, not events), and cells of a fine grid on the line's own axis, for windows on it.
 */
export class RangeRecords {
    readonly starts: Uint32Array;       // per range: its first event, plus the end of the events
    readonly recordStarts: Uint32Array; // per range: its first record, plus the end of the records
    signatures = new Uint32Array(16);   // per record
    weights = new Float64Array(16);     // per record: sum of event weights

    constructor(signatures: EventSignatures, starts: Uint32Array, weights: Uint32Array) {
        const { ids } = signatures;
        const rangeCount = starts.length - 1;
        const recordStarts = new Uint32Array(rangeCount + 1);
        // Per signature: the last range it occurred in and its sum there; signatures of a range in the order
        // of their first event
        const signatureRanges = new Int32Array(signatures.count).fill(-1);
        const rangeWeights = new Float64Array(signatures.count);
        const rangeSignatures = new Uint32Array(signatures.count);
        let count = 0;

        for (let range = 0; range < rangeCount; range++) {
            let signatureCount = 0;

            for (let event = starts[range]; event < starts[range + 1]; event++) {
                const signature = ids[event];

                if (signatureRanges[signature] !== range) {
                    signatureRanges[signature] = range;
                    rangeWeights[signature] = 0;
                    rangeSignatures[signatureCount++] = signature;
                }

                rangeWeights[signature] += weights[event];
            }

            while (count + signatureCount > this.signatures.length) {
                this.signatures = grow(this.signatures);
                this.weights = grow(this.weights);
            }

            recordStarts[range] = count;

            for (let index = 0; index < signatureCount; index++) {
                const signature = rangeSignatures[index];

                this.signatures[count] = signature;
                this.weights[count++] = rangeWeights[signature];
            }
        }

        recordStarts[rangeCount] = count;
        this.starts = starts;
        this.recordStarts = recordStarts;
        this.signatures = this.signatures.slice(0, count);
        this.weights = this.weights.slice(0, count);
    }
}

// Starts of the events of every target, for a nondecreasing mapping
function targetStarts(mapping: Uint32Array, targetCount: number) {
    const starts = new Uint32Array(targetCount + 1);
    let target = -1;

    for (let event = 0; event < mapping.length; event++) {
        while (target < mapping[event]) {
            starts[++target] = event;
        }
    }

    starts.fill(mapping.length, target + 1);

    return starts;
}

// Starts of the events of every cell of a grid on a line's own axis: events starting in a cell
function cellStarts(cumulative: Float64Array, cumulativeEnd: number, cellCount: number) {
    const starts = new Uint32Array(cellCount + 1);
    const step = cumulativeEnd / cellCount;
    let cell = 0;

    for (let event = 0; event < cumulative.length; event++) {
        const eventCell = Math.min(cellCount - 1, Math.floor(cumulative[event] / step));

        while (cell < eventCell) {
            starts[++cell] = event;
        }
    }

    starts.fill(cumulative.length, cell + 1);

    return starts;
}

/**
 * Whole events of the spans of one binning grid, grouped by signature (and by the signature of the mapped
 * event when the grid is on another line's axis). A span is a range of events that an aggregation adds to
 * one bin without cutting them; the aggregation visits spans in a fixed order for a grid, so the first
 * aggregation over the grid records them and later ones, with any filters or groups, reuse the records.
 */
export class BinRecords {
    readonly grid: BinRecordsGrid;
    complete = false;
    spanStarts = new Uint32Array(16);       // per span: its first record, plus the end of the last span
    spanCount = 0;
    signatures = new Uint32Array(16);       // per record
    axisSignatures = new Uint32Array(0);    // per record of a grid on another line's axis
    bins = new Int32Array(0);               // per record of a grid on another line's axis
    weights = new Float64Array(16);         // per record: sum of event weights
    count = 0;
    // Per signature: the last group it was recorded in and its first record there
    #signatureGroups: Int32Array;
    #signatureRecords: Uint32Array;
    #nextRecords = new Int32Array(0);       // per record: the next record of its signature in the group
    #spanWeights = new Float64Array(0);     // per signature: its sum in the span being recorded
    #group = 0;

    constructor(grid: BinRecordsGrid, signatureCount: number) {
        this.grid = grid;
        this.#signatureGroups = new Int32Array(signatureCount).fill(-1);
        this.#signatureRecords = new Uint32Array(signatureCount);
    }

    matches({ total, step, skip, ranges, axisRanges }: BinRecordsGrid) {
        const { grid } = this;

        return grid.total === total &&
            grid.step === step &&
            grid.skip === skip &&
            equalRanges(grid.ranges, ranges) &&
            equalRanges(grid.axisRanges, axisRanges);
    }

    // Records the next span from events [first, last) of a line
    addSpan(signatures: EventSignatures, weights: Uint32Array, first: number, last: number, cells: RangeRecords | null) {
        const { ids } = signatures;
        const group = this.#group++;
        const signatureGroups = this.#signatureGroups;
        // Sums of the span per signature and the signatures in the order of their first event
        const spanWeights = this.#spanWeights.length === signatureGroups.length
            ? this.#spanWeights
            : this.#spanWeights = new Float64Array(signatureGroups.length);
        const spanSignatures = this.#signatureRecords;
        let spanCount = 0;

        let event = first;

        // Events before the first whole cell, records of whole cells, then the rest of the events
        if (cells !== null) {
            const { starts, recordStarts, signatures: cellSignatures, weights: cellWeights } = cells;
            let cell = lowerBound(starts, first);
            const firstEnd = Math.min(last, starts[cell]);

            for (; event < firstEnd; event++) {
                const signature = ids[event];

                if (signatureGroups[signature] !== group) {
                    signatureGroups[signature] = group;
                    spanWeights[signature] = 0;
                    spanSignatures[spanCount++] = signature;
                }

                spanWeights[signature] += weights[event];
            }

            for (; cell < starts.length - 1 && starts[cell + 1] <= last; cell++) {
                for (let record = recordStarts[cell]; record < recordStarts[cell + 1]; record++) {
                    const signature = cellSignatures[record];

                    if (signatureGroups[signature] !== group) {
                        signatureGroups[signature] = group;
                        spanWeights[signature] = 0;
                        spanSignatures[spanCount++] = signature;
                    }

                    spanWeights[signature] += cellWeights[record];
                }

                event = starts[cell + 1];
            }
        }

        for (; event < last; event++) {
            const signature = ids[event];

            if (signatureGroups[signature] !== group) {
                signatureGroups[signature] = group;
                spanWeights[signature] = 0;
                spanSignatures[spanCount++] = signature;
            }

            spanWeights[signature] += weights[event];
        }

        for (let index = 0; index < spanCount; index++) {
            const signature = spanSignatures[index];
            const record = this.#push(signature, 0, 0);

            this.weights[record] = spanWeights[signature];
        }

        this.#endSpan();
    }

    // Records the next span from events [first, last) of a line placed on another line's axis: by the bin
    // of their mapped events and by the signatures of the mapped events in the other line. Whole targets
    // come from target records when given
    addMappedSpan(
        signatures: EventSignatures,
        weights: Uint32Array,
        first: number,
        last: number,
        mapping: Uint32Array,
        axisSignatures: EventSignatures,
        targetBin: (target: number) => number,
        targets: RangeRecords | null
    ) {
        const { ids } = signatures;
        let previousBin = -1;
        let group = -1;
        let event = first;

        if (this.bins.length < this.signatures.length) {
            this.#growMapped();
        }

        while (event < last) {
            const target = mapping[event];
            const bin = targetBin(target);
            const axisSignature = axisSignatures.ids[target];

            if (bin !== previousBin || group === -1) {
                previousBin = bin;
                group = this.#group++;
            }

            if (targets !== null && targets.starts[target] === event && targets.starts[target + 1] <= last) {
                if (bin !== -1) {
                    for (let record = targets.recordStarts[target]; record < targets.recordStarts[target + 1]; record++) {
                        this.#addMapped(group, targets.signatures[record], axisSignature, bin, targets.weights[record]);
                    }
                }

                event = targets.starts[target + 1];
            } else {
                for (; event < last && mapping[event] === target; event++) {
                    if (bin !== -1) {
                        this.#addMapped(group, ids[event], axisSignature, bin, weights[event]);
                    }
                }
            }
        }

        this.#endSpan();
    }

    #addMapped(group: number, signature: number, axisSignature: number, bin: number, weight: number) {
        let record = -1;

        if (this.#signatureGroups[signature] === group) {
            for (let candidate = this.#signatureRecords[signature]; candidate !== -1; candidate = this.#nextRecords[candidate]) {
                if (this.axisSignatures[candidate] === axisSignature) {
                    record = candidate;
                    break;
                }
            }

            if (record === -1) {
                record = this.#push(signature, axisSignature, bin);
                this.#nextRecords[record] = this.#nextRecords[this.#signatureRecords[signature]];
                this.#nextRecords[this.#signatureRecords[signature]] = record;
            }
        } else {
            record = this.#push(signature, axisSignature, bin);
            this.#signatureGroups[signature] = group;
            this.#signatureRecords[signature] = record;
        }

        this.weights[record] += weight;
    }

    // Marks the records as covering every span of the grid and releases the recording state
    finish() {
        this.complete = true;
        this.#signatureGroups = new Int32Array(0);
        this.#signatureRecords = new Uint32Array(0);
        this.#nextRecords = new Int32Array(0);
        this.#spanWeights = new Float64Array(0);
    }

    #push(signature: number, axisSignature: number, bin: number) {
        if (this.count === this.signatures.length) {
            this.signatures = grow(this.signatures);
            this.weights = grow(this.weights);

            if (this.bins.length > 0) {
                this.#growMapped();
            }
        }

        const record = this.count++;

        this.signatures[record] = signature;
        this.weights[record] = 0;

        if (this.bins.length > 0) {
            this.axisSignatures[record] = axisSignature;
            this.bins[record] = bin;
            this.#nextRecords[record] = -1;
        }

        return record;
    }

    #growMapped() {
        const length = this.signatures.length;
        const axisSignatures = new Uint32Array(length);
        const bins = new Int32Array(length);
        const nextRecords = new Int32Array(length);

        axisSignatures.set(this.axisSignatures);
        bins.set(this.bins);
        nextRecords.set(this.#nextRecords);
        this.axisSignatures = axisSignatures;
        this.bins = bins;
        this.#nextRecords = nextRecords;
    }

    #endSpan() {
        if (this.spanCount + 1 === this.spanStarts.length) {
            this.spanStarts = grow(this.spanStarts);
        }

        this.spanStarts[++this.spanCount] = this.count;
    }
}

function collectSignatureColumns(line: ProfileLine) {
    const columns: SignatureColumn[] = [];
    const add = (values: SignatureColumn['values'], samples: Uint32Array | null, filtered = false) => {
        const column = columns.find(column => column.values === values && column.samples === samples);

        if (column === undefined) {
            columns.push({ values, samples, filtered });
        } else {
            column.filtered ||= filtered;
        }
    };

    for (const { name, values } of line.attributes) {
        if (!IDENTITY_ATTRIBUTES.has(name)) {
            add(values, null);
        }
    }

    for (const { categories, population } of line.breakdowns) {
        if (categories !== null) {
            add(categories.sampleToNode, population.samples);
        }
    }

    for (const population of new Set(line.breakdowns.map(breakdown => breakdown.populationViewport))) {
        for (const { domain, values } of population.filter.filters) {
            if (values !== undefined) {
                add(values, domain === 'sample' ? population.population.samples : null, domain === 'event');
            }
        }
    }

    return columns;
}

// Columns given per sample of one population are functions of the sample; they are reduced to one class per
// sample, so the event key has one column per population instead of one per breakdown and filter
function keyColumns(columns: SignatureColumn[]) {
    const keys = columns.filter(column => column.samples === null);

    for (const samples of new Set(columns.map(column => column.samples))) {
        if (samples !== null) {
            const sampleColumns = columns
                .filter(column => column.samples === samples)
                .map(({ values }) => ({ values, samples: null, filtered: false }));

            keys.push({ values: assignSignatures(sampleColumns[0].values.length, sampleColumns).ids, samples, filtered: false });
        }
    }

    return keys;
}

// Copies column values of events [start, end) into the key scratch, where keys of an event are consecutive
function gatherColumn({ values, samples }: SignatureColumn, keys: Uint32Array, column: number, columnCount: number, start: number, end: number) {
    let offset = column;

    if (samples === null) {
        for (let event = start; event < end; event++, offset += columnCount) {
            keys[offset] = values[event];
        }
    } else {
        for (let event = start; event < end; event++, offset += columnCount) {
            keys[offset] = values[samples[event]];
        }
    }
}

// Events are processed in chunks. Their keys (values of every column) are gathered into a scratch, so hashing
// and comparison read consecutive elements of one typed array; keys are looked up in a hash table of signatures.
function assignSignatures(eventCount: number, columns: SignatureColumn[]) {
    const columnCount = columns.length;
    // PERF: Scratch and tables start at the size of the line, so small lines allocate little
    const chunkLength = Math.min(CHUNK_LENGTH, Math.max(1, eventCount));
    const keys = new Uint32Array(columnCount * chunkLength);
    const hashes = new Uint32Array(chunkLength);
    // PERF: Signature IDs are event-sized; widen them only when the signatures outgrow 16 bits
    let ids: Uint16Array | Uint32Array = new Uint16Array(eventCount);
    let slots = new Int32Array(2 ** Math.ceil(Math.log2(Math.max(16, Math.min(2 * eventCount, 1 << 16))))).fill(-1);
    let slotHashes = new Uint32Array(slots.length);
    let signatureKeys = new Uint32Array(columnCount * 16);
    let signatureEvents = new Uint32Array(16);
    let count = 0;

    const equalKeys = (signature: number, offset: number) => {
        const base = signature * columnCount;

        for (let column = 0; column < columnCount; column++) {
            if (signatureKeys[base + column] !== keys[offset + column]) {
                return false;
            }
        }

        return true;
    };

    const growSlots = () => {
        const previousSlots = slots;
        const previousHashes = slotHashes;
        const mask = previousSlots.length * 2 - 1;

        slots = new Int32Array(previousSlots.length * 2).fill(-1);
        slotHashes = new Uint32Array(slots.length);

        for (let index = 0; index < previousSlots.length; index++) {
            if (previousSlots[index] !== -1) {
                let slot = previousHashes[index] & mask;

                while (slots[slot] !== -1) {
                    slot = (slot + 1) & mask;
                }

                slots[slot] = previousSlots[index];
                slotHashes[slot] = previousHashes[index];
            }
        }
    };

    // Keys at two scratch offsets are equal
    const equalEventKeys = (a: number, b: number) => {
        for (let column = 0; column < columnCount; column++) {
            if (keys[a + column] !== keys[b + column]) {
                return false;
            }
        }

        return true;
    };

    const findSignature = (event: number, offset: number, hash: number) => {
        const mask = slots.length - 1;
        let slot = hash & mask;

        while (slots[slot] !== -1) {
            if (slotHashes[slot] === hash && equalKeys(slots[slot], offset)) {
                return slots[slot];
            }

            slot = (slot + 1) & mask;
        }

        if (count === signatureEvents.length) {
            signatureEvents = grow(signatureEvents);
            signatureKeys = grow(signatureKeys);
        }

        if (count === 0x10000 && ids instanceof Uint16Array) {
            ids = Uint32Array.from(ids);
        }

        signatureKeys.set(keys.subarray(offset, offset + columnCount), count * columnCount);
        signatureEvents[count] = event;
        slots[slot] = count;
        slotHashes[slot] = hash;

        if (2 * ++count > slots.length) {
            growSlots();
        }

        return count - 1;
    };

    let previous = -1;

    for (let chunkStart = 0; chunkStart < eventCount; chunkStart += chunkLength) {
        const chunkEnd = Math.min(eventCount, chunkStart + chunkLength);
        const length = chunkEnd - chunkStart;

        for (let column = 0; column < columnCount; column++) {
            gatherColumn(columns[column], keys, column, columnCount, chunkStart, chunkEnd);
        }

        for (let index = 0, offset = 0; index < length; index++) {
            let hash = 0x811c9dc5;

            for (let column = 0; column < columnCount; column++, offset++) {
                hash = Math.imul(hash ^ keys[offset], 0x01000193);
            }

            hashes[index] = (hash ^ (hash >>> 15)) >>> 0;
        }

        // An event with the key of the previous one in the chunk takes its signature without a lookup
        for (let index = 0, offset = 0; index < length; index++, offset += columnCount) {
            const isRepeat = index > 0 &&
                hashes[index] === hashes[index - 1] &&
                equalEventKeys(offset, offset - columnCount);

            if (!isRepeat) {
                previous = findSignature(chunkStart + index, offset, hashes[index]);
            }

            ids[chunkStart + index] = previous;
        }
    }

    return {
        ids,
        events: signatureEvents.slice(0, count)
    };
}

function grow<T extends Uint32Array | Int32Array | Float64Array>(array: T): T {
    const grown = new (array.constructor as new (length: number) => T)(array.length * 2);

    grown.set(array);

    return grown;
}
