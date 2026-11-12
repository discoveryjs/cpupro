import type { PopulationFiltered } from '../computations/population.js';
import type { EventClasses } from '../computations/population-filter.js';
import type { PreparedAttributeFilter } from '../computations/attribute-filter.js';
import { equalRanges, type RangeSet } from '../computations/coordinates.js';
import { lowerBound } from '../computations/misc.js';
import { growTypedArray } from '../misc/utils.js';
import type { ProfileLine, ProfileLineAttribute } from './types.js';

// Identity-like attributes have about as many values as there are signatures; grouping by them would
// multiply signatures and records for every aggregation, so their own consumers aggregate events directly
const IDENTITY_ATTRIBUTES = new Set<ProfileLineAttribute['name']>(['allocationOwner']);
// Windows with up to this many events take their records from events, a pass of about 2 ms
const WINDOW_EVENTS = 1 << 20;
// Bins of a window's data grid
const WINDOW_BINS = 2000;
// Combinations of ids and the columns combined in one pass; larger tables combine fewer columns at a time
const PASS_TABLE_LENGTH = 1 << 24;

type ColumnValues = Uint8Array | Uint16Array | Uint32Array;
type SignatureColumn = {
    values: ColumnValues;
    // Base population samples when values are given per sample, null when values are given per event
    samples: Uint32Array | null;
    // Values are below it
    size: number;
};

export type BinRecordsGrid = {
    total: number;
    step: number;
    skip: number;
    ranges: RangeSet | null;
    axisRanges: RangeSet | null;
    // Records place events on another line's axis
    mapped: boolean;
};

/**
 * Signatures of line events: the combination of values that aggregations and filters distinguish, without
 * the event's value. Events of one signature have equal values of every attribute (except identity-like ones),
 * equal category nodes in every breakdown and equal values of every registered filter partition, so they are
 * accepted or rejected together and fall into the same track of every histogram.
 */
export class EventSignatures {
    readonly ids: Uint32Array;     // per event
    readonly events: Uint32Array;  // per signature: its first event
    readonly weights: Uint32Array; // per event: the line's value
    readonly #columns: Map<ColumnValues, SignatureColumn>;
    readonly #signatureValues = new Map<ColumnValues, Uint32Array>();
    readonly #binRecords = new Map<string, { grid: BinRecordsGrid; records: BinRecords }>();
    // Per mapping of the line's events
    readonly #targetRecords = new Map<Uint32Array, RangeRecords>();
    // Per cumulative vector of the line's events
    readonly #cellRecords = new Map<Float64Array, RangeRecords | null>();
    #totals: Float64Array | null = null;

    // Columns other than those of the classes are combined with the classes of events: a dense table maps an id
    // of the columns combined so far and a value of the next column to the id of their combination, so an event
    // takes a table read per column
    constructor(line: ProfileLine) {
        const classes = line.eventClasses;
        const columns = collectSignatureColumns(line);
        const otherColumns = keyColumns(columns)
            .filter(column => !classes.values.has(column.values))
            .sort(bySize);
        const ids = new Uint32Array(classes.ids.length);

        this.ids = ids;
        this.events = Uint32Array.from(combineColumns(classes.ids, ids, Array.from(classes.events), otherColumns));
        this.weights = line.values;
        this.#columns = columns;

        // Events of a signature share the values of every column, so its first event gives them
        for (const column of columns.values()) {
            this.#signatureValues.set(column.values, signatureValues(column, this.events));
        }
    }

    get count() {
        return this.events.length;
    }

    // Value of every signature for an attribute or a breakdown's sample-to-category-node mapping
    valuesOf(values: ColumnValues) {
        return this.#signatureValues.get(values) ?? null;
    }

    // Weight of the events of every signature over the whole line, computed on the first use and kept,
    // since neither the events nor their signatures change
    totals() {
        if (this.#totals === null) {
            const { ids, weights } = this;

            this.#totals = new Float64Array(this.count);

            for (let i = 0; i < ids.length; i++) {
                this.#totals[ids[i]] += weights[i];
            }
        }

        return this.#totals;
    }

    // Weight of the line's events by a column's values, from the weights of signatures; null when the values are
    // not a column of the signatures
    totalsBy(values: ColumnValues, valueCount: number) {
        const signatureValues = this.valuesOf(values);

        if (signatureValues === null) {
            return null;
        }

        const signatureTotals = this.totals();
        const totals = new Float64Array(valueCount);

        for (let i = 0; i < signatureTotals.length; i++) {
            totals[signatureValues[i]] += signatureTotals[i];
        }

        return totals;
    }

    // Acceptance of every signature by a population of the line, or null when the population may accept
    // events of one signature differently: a filter over other values
    acceptance(population: PopulationFiltered) {
        if (population.source !== population.population) {
            return null;
        }

        const { filters } = population.filter;

        for (let i = 0; i < filters.length; i++) {
            if (filters[i].accepts !== null && !this.#keeps(filters[i], population.population.samples)) {
                return null;
            }
        }

        const { sinkId } = population;
        const { destination } = population.eventReader();
        const { events } = this;
        const accepted = new Uint8Array(events.length);

        for (let i = 0; i < events.length; i++) {
            if (destination(events[i]) !== sinkId) {
                accepted[i] = 1;
            }
        }

        return accepted;
    }

    // Records of one binning grid; replaced when the grid changes (a window or bin count change). Records of a
    // grid over unrestricted populations, the whole extent where zooming out returns, are kept apart from the
    // records of a window
    binRecords(key: string, grid: BinRecordsGrid) {
        const recordsKey = grid.ranges === null && grid.axisRanges === null
            ? key + ':unrestricted'
            : key;
        const entry = this.#binRecords.get(recordsKey);

        if (entry !== undefined && equalGrids(entry.grid, grid)) {
            return entry.records;
        }

        const records = new BinRecords(this.count, grid.mapped);

        this.#binRecords.set(recordsKey, { grid, records });

        return records;
    }

    // Records of the events of every target in another line, for a nondecreasing mapping; built on the first use
    // and kept, since neither the events nor their signatures change
    targetRecords(mapping: Uint32Array, targetCount: number) {
        let records = this.#targetRecords.get(mapping);

        if (records === undefined) {
            records = new RangeRecords(this, targetStarts(mapping, targetCount));
            this.#targetRecords.set(mapping, records);
        }

        return records;
    }

    // Records of the cells of a fine grid on the line's own axis: WINDOW_BINS cells per window of the deepest
    // window level whose windows average more than WINDOW_EVENTS events, so bins of windows of that and coarser
    // levels hold whole cells for bin counts dividing WINDOW_BINS times a power of two; deeper windows have few
    // events. Null when the line has few events. Built on the first use and kept.
    cellRecords(cumulative: Float64Array, cumulativeEnd: number, windowEvents = WINDOW_EVENTS) {
        let records = this.#cellRecords.get(cumulative);

        if (records === undefined) {
            records = null;

            if (cumulative.length > windowEvents && cumulativeEnd > 0) {
                const level = Math.ceil(Math.log2(cumulative.length / windowEvents)) - 1;

                records = new RangeRecords(this, cellStarts(cumulative, cumulativeEnd, WINDOW_BINS * 2 ** level));
            }

            this.#cellRecords.set(cumulative, records);
        }

        return records;
    }

    // The values of a filter are a column of the signatures, indexed as the filter reads them
    #keeps(filter: PreparedAttributeFilter, baseSamples: Uint32Array) {
        if (filter.values === undefined) {
            return false;
        }

        const column = this.#columns.get(filter.values);
        const samples = filter.domain === 'sample'
            ? baseSamples
            : null;

        return column !== undefined && column.samples === samples;
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
    readonly signatures: Uint32Array;   // per record
    readonly weights: Float64Array;     // per record: sum of event weights

    constructor(signatures: EventSignatures, starts: Uint32Array) {
        const records = new BinRecords(signatures.count, false);
        const rangeCount = starts.length - 1;

        for (let i = 0; i < rangeCount; i++) {
            records.addSpan(signatures, starts[i], starts[i + 1], null);
        }

        this.starts = starts;
        this.recordStarts = records.spanStarts.slice(0, records.spanCount + 1);
        this.signatures = records.signatures.slice(0, records.count);
        this.weights = records.weights.slice(0, records.count);
    }
}

// Starts of the events of every target, for a nondecreasing mapping
function targetStarts(mapping: Uint32Array, targetCount: number) {
    const starts = new Uint32Array(targetCount + 1);
    let start = 0;

    // PERF: Targets of a nondecreasing mapping follow each other closely, so the start of a target is searched
    // from the start of the one before it: doubling steps find an end of the search, halving finds the start in it,
    // reading a few entries near it rather than all of them
    for (let i = 0; i <= targetCount; i++) {
        let end = start;
        let step = 1;

        while (end < mapping.length && mapping[end] < i) {
            start = end + 1;
            end += step;
            step *= 2;
        }

        end = Math.min(end, mapping.length);

        while (start < end) {
            const middle = (start + end) >>> 1;

            if (mapping[middle] < i) {
                start = middle + 1;
            } else {
                end = middle;
            }
        }

        starts[i] = start;
    }

    return starts;
}

// Starts of the events of every cell of a grid on a line's own axis: events starting in a cell
function cellStarts(cumulative: Float64Array, cumulativeEnd: number, cellCount: number) {
    const starts = new Uint32Array(cellCount + 1);
    const step = cumulativeEnd / cellCount;
    let cell = 0;

    for (let i = 0; i < cumulative.length; i++) {
        const eventCell = Math.min(cellCount - 1, Math.floor(cumulative[i] / step));

        while (cell < eventCell) {
            starts[++cell] = i;
        }
    }

    starts.fill(cumulative.length, cell + 1);

    return starts;
}

/**
 * Whole events of consecutive spans grouped by signature (and by the signature and bin of the mapped event when
 * the spans are placed on another line's axis), a record per group in the order of their first events. A span of
 * a binning grid is a range of events that an aggregation adds to one bin without cutting them; the aggregation
 * visits spans in a fixed order for a grid, so the first aggregation over the grid records them and later ones,
 * with any filters or groups, reuse the records.
 */
export class BinRecords {
    complete = false;
    spanStarts = new Uint32Array(16);    // per span: its first record, plus the end of the last span
    spanCount = 0;
    signatures = new Uint32Array(16);    // per record
    axisSignatures = new Uint32Array(0); // per record of a mapped grid
    bins = new Int32Array(0);            // per record of a mapped grid
    weights = new Float64Array(16);      // per record: sum of event weights
    count = 0;
    // Per signature: the last group it was recorded in
    #signatureGroups: Int32Array;
    // Per signature: its sum in the span, and the signatures of the span in the order of their first events
    #signatureSums = new Float64Array(0);
    #spanSignatures = new Uint32Array(0);
    #spanSignatureCount = 0;
    // Per signature of a mapped grid: its first record in the group; per record: the next record of its signature
    #signatureRecords = new Uint32Array(0);
    #nextRecords = new Int32Array(0);
    #group = 0;
    readonly #mapped: boolean;

    constructor(signatureCount: number, mapped: boolean) {
        this.#signatureGroups = new Int32Array(signatureCount).fill(-1);
        this.#mapped = mapped;

        if (mapped) {
            this.#signatureRecords = new Uint32Array(signatureCount);
            this.#nextRecords = new Int32Array(this.signatures.length);
            this.axisSignatures = new Uint32Array(this.signatures.length);
            this.bins = new Int32Array(this.signatures.length);
        } else {
            this.#signatureSums = new Float64Array(signatureCount);
            this.#spanSignatures = new Uint32Array(signatureCount);
        }
    }

    // Records the next span from events [first, last) of a line: events before the first whole cell, records
    // of whole cells, then the rest of the events
    addSpan(signatures: EventSignatures, first: number, last: number, cells: RangeRecords | null) {
        const group = this.#group++;
        let start = first;

        if (cells !== null) {
            const { starts } = cells;
            const cellCount = starts.length - 1;
            let cell = lowerBound(starts, first);

            start = Math.min(last, starts[cell]);
            this.#addEvents(signatures, group, first, start);

            for (; cell < cellCount && starts[cell + 1] <= last; cell++) {
                const recordsEnd = cells.recordStarts[cell + 1];

                for (let i = cells.recordStarts[cell]; i < recordsEnd; i++) {
                    this.#add(group, cells.signatures[i], cells.weights[i]);
                }

                start = starts[cell + 1];
            }
        }

        this.#addEvents(signatures, group, start, last);

        for (let i = 0; i < this.#spanSignatureCount; i++) {
            const signature = this.#spanSignatures[i];
            const record = this.#push(signature, 0, 0);

            this.weights[record] = this.#signatureSums[signature];
        }

        this.#spanSignatureCount = 0;
        this.#endSpan();
    }

    // Records the next span from events [first, last) of a line placed on another line's axis: by the bin
    // of their mapped events and by the signatures of the mapped events in the other line. Whole targets
    // come from target records when given
    addMappedSpan(
        signatures: EventSignatures,
        first: number,
        last: number,
        mapping: Uint32Array,
        axisSignatures: EventSignatures,
        targetBin: (target: number) => number,
        targets: RangeRecords | null
    ) {
        const { ids, weights } = signatures;
        let previousBin = -1;
        let group = -1;
        let i = first;

        while (i < last) {
            const target = mapping[i];
            const bin = targetBin(target);
            const axisSignature = axisSignatures.ids[target];

            if (bin !== previousBin || group === -1) {
                previousBin = bin;
                group = this.#group++;
            }

            if (targets !== null && targets.starts[target] === i && targets.starts[target + 1] <= last) {
                const recordsEnd = targets.recordStarts[target + 1];

                if (bin !== -1) {
                    for (let j = targets.recordStarts[target]; j < recordsEnd; j++) {
                        const record = this.#mappedRecord(group, targets.signatures[j], axisSignature, bin);

                        this.weights[record] += targets.weights[j];
                    }
                }

                i = targets.starts[target + 1];
            } else {
                for (; i < last && mapping[i] === target; i++) {
                    if (bin !== -1) {
                        const record = this.#mappedRecord(group, ids[i], axisSignature, bin);

                        this.weights[record] += weights[i];
                    }
                }
            }
        }

        this.#endSpan();
    }

    // Marks the records as covering every span of the grid and releases the recording state
    finish() {
        this.complete = true;
        this.#signatureGroups = new Int32Array(0);
        this.#signatureSums = new Float64Array(0);
        this.#signatureRecords = new Uint32Array(0);
        this.#nextRecords = new Int32Array(0);
        this.#spanSignatures = new Uint32Array(0);
    }

    #addEvents(signatures: EventSignatures, group: number, start: number, end: number) {
        const { ids, weights } = signatures;

        for (let i = start; i < end; i++) {
            this.#add(group, ids[i], weights[i]);
        }
    }

    // Adds a weight to the sum of a signature in the span
    #add(group: number, signature: number, weight: number) {
        if (this.#signatureGroups[signature] !== group) {
            this.#signatureGroups[signature] = group;
            this.#signatureSums[signature] = 0;
            this.#spanSignatures[this.#spanSignatureCount++] = signature;
        }

        this.#signatureSums[signature] += weight;
    }

    // The record of a signature and the signature of its mapped events in a group
    #mappedRecord(group: number, signature: number, axisSignature: number, bin: number) {
        if (this.#signatureGroups[signature] !== group) {
            this.#signatureGroups[signature] = group;
            this.#signatureRecords[signature] = this.#push(signature, axisSignature, bin);

            return this.#signatureRecords[signature];
        }

        const first = this.#signatureRecords[signature];

        for (let i = first; i !== -1; i = this.#nextRecords[i]) {
            if (this.axisSignatures[i] === axisSignature) {
                return i;
            }
        }

        const record = this.#push(signature, axisSignature, bin);

        this.#nextRecords[record] = this.#nextRecords[first];
        this.#nextRecords[first] = record;

        return record;
    }

    #push(signature: number, axisSignature: number, bin: number) {
        if (this.count === this.signatures.length) {
            this.signatures = growTypedArray(this.signatures);
            this.weights = growTypedArray(this.weights);

            if (this.#mapped) {
                this.axisSignatures = growTypedArray(this.axisSignatures);
                this.bins = growTypedArray(this.bins);
                this.#nextRecords = growTypedArray(this.#nextRecords);
            }
        }

        const record = this.count++;

        this.signatures[record] = signature;
        this.weights[record] = 0;

        if (this.#mapped) {
            this.axisSignatures[record] = axisSignature;
            this.bins[record] = bin;
            this.#nextRecords[record] = -1;
        }

        return record;
    }

    #endSpan() {
        if (this.spanCount + 1 === this.spanStarts.length) {
            this.spanStarts = growTypedArray(this.spanStarts);
        }

        this.spanStarts[++this.spanCount] = this.count;
    }
}

function equalGrids(left: BinRecordsGrid, right: BinRecordsGrid) {
    return (
        left.total === right.total &&
        left.step === right.step &&
        left.skip === right.skip &&
        left.mapped === right.mapped &&
        equalRanges(left.ranges, right.ranges) &&
        equalRanges(left.axisRanges, right.axisRanges)
    );
}

// Classes of events with equal values of every attribute with an event filter. Columns are combined one, two or
// three at a time, a column of fewer values first keeps tables smaller. Implied attributes are functions of the
// combined ones: they split no class, so they are classified without being combined
export function createEventClasses(
    eventCount: number,
    attributes: ProfileLineAttribute[],
    impliedAttributes: ProfileLineAttribute[]
): EventClasses {
    const columns = attributeColumns(attributes).sort(bySize);
    const ids = new Uint32Array(eventCount);
    // Events have one combination of no columns
    const noColumns = eventCount > 0 ? [0] : [];
    const events = combineColumns(ids, ids, noColumns, columns);
    const values = new Set<ColumnValues>();

    for (let i = 0; i < columns.length; i++) {
        values.add(columns[i].values);
    }

    for (let i = 0; i < impliedAttributes.length; i++) {
        values.add(impliedAttributes[i].values);
    }

    return {
        // PERF: Classes rarely outgrow 16 bits, then their event-sized vector takes half the memory
        ids: events.length <= 0x10000
            ? new Uint16Array(ids)
            : ids,
        events: Uint32Array.from(events),
        values
    };
}

// Columns of the values of attributes, given per event
function attributeColumns(attributes: ProfileLineAttribute[]) {
    const columns: SignatureColumn[] = [];

    for (let i = 0; i < attributes.length; i++) {
        columns.push({
            values: attributes[i].values,
            samples: null,
            size: attributes[i].dict.length
        });
    }

    return columns;
}

function bySize(left: SignatureColumn, right: SignatureColumn) {
    return left.size - right.size;
}

// Columns of the line's attributes, breakdown categories and registered filters, one per vector of values
function collectSignatureColumns(line: ProfileLine) {
    const columns = new Map<ColumnValues, SignatureColumn>();
    const add = (values: ColumnValues, samples: Uint32Array | null) => {
        if (!columns.has(values)) {
            columns.set(values, {
                values,
                samples,
                size: valueCount(values)
            });
        }
    };

    const attributes = attributeColumns(line.attributes.filter(attribute => !IDENTITY_ATTRIBUTES.has(attribute.name)));

    for (let i = 0; i < attributes.length; i++) {
        columns.set(attributes[i].values, attributes[i]);
    }

    for (let i = 0; i < line.breakdowns.length; i++) {
        const { categories, population, populationViewport } = line.breakdowns[i];
        const { filters } = populationViewport.filter;

        if (categories !== null) {
            add(categories.sampleToNode, population.samples);
        }

        for (let j = 0; j < filters.length; j++) {
            const { domain, values } = filters[j];
            const samples = domain === 'sample'
                ? population.samples
                : null;

            if (values !== undefined) {
                add(values, samples);
            }
        }
    }

    return columns;
}

function valueCount(values: ColumnValues) {
    let max = -1;

    for (let i = 0; i < values.length; i++) {
        max = Math.max(max, values[i]);
    }

    return max + 1;
}

// Columns given per sample of one population are functions of the sample; they are combined into one class per
// sample first, so events take one column per population instead of one per breakdown and filter
function keyColumns(columns: Map<ColumnValues, SignatureColumn>) {
    const keys: SignatureColumn[] = [];
    const sampleColumns = new Map<Uint32Array, SignatureColumn[]>();

    for (const column of columns.values()) {
        if (column.samples === null) {
            keys.push(column);
            continue;
        }

        const group = sampleColumns.get(column.samples);

        if (group === undefined) {
            sampleColumns.set(column.samples, [column]);
        } else {
            group.push(column);
        }
    }

    for (const [samples, group] of sampleColumns) {
        const sampleClasses = new Uint32Array(group[0].values.length);
        let count = 1;

        for (let i = 0; i < group.length; i++) {
            count = combineColumn(sampleClasses, sampleClasses, count, group[i].values, null, group[i].size).length;
        }

        keys.push({
            values: sampleClasses,
            samples,
            size: count
        });
    }

    return keys;
}

// Combines the ids of events with the values of every column; `events` are the first events of the ids, the first
// events of the combinations are returned. The first pass reads the ids from `sourceIds`, later passes from `ids`.
// A pass over the events costs about the same for one, two or three columns, so columns read alike are combined
// several at a time while their table stays small
function combineColumns(sourceIds: ColumnValues, ids: Uint32Array, events: number[], columns: SignatureColumn[]) {
    let source = sourceIds;
    let i = 0;

    if (columns.length === 0) {
        ids.set(sourceIds);
    }

    while (i < columns.length) {
        const column = columns[i];
        const next = i + 1 < columns.length
            ? columns[i + 1]
            : null;
        const third = i + 2 < columns.length
            ? columns[i + 2]
            : null;

        if (next !== null && third !== null && triplable(column, next, third, events.length)) {
            events = combineTriple(source, ids, events.length, column, next, third);
            i += 3;
        } else if (next !== null && pairable(column, next, events.length)) {
            events = combinePair(source, ids, events.length, column, next);
            i += 2;
        } else {
            events = combineColumn(source, ids, events.length, column.values, column.samples, column.size);
            i++;
        }

        source = ids;
    }

    return events;
}

// Both columns are read per event or both per sample, and the table of their combinations with `count` ids is small
function pairable(left: SignatureColumn, right: SignatureColumn, count: number) {
    return (
        (left.samples === null) === (right.samples === null) &&
        count * left.size * right.size <= PASS_TABLE_LENGTH
    );
}

// Three columns read per event, and the table of their combinations with `count` ids is small
function triplable(first: SignatureColumn, second: SignatureColumn, third: SignatureColumn, count: number) {
    return (
        first.samples === null &&
        second.samples === null &&
        third.samples === null &&
        count * first.size * second.size * third.size <= PASS_TABLE_LENGTH
    );
}

// Replaces ids of `count` combinations of earlier columns by the ids of their combinations with the values of three
// columns read per event, numbered in the order of their first entries; returns the first entry of every combination
function combineTriple(
    sourceIds: ColumnValues,
    ids: Uint32Array,
    count: number,
    first: SignatureColumn,
    second: SignatureColumn,
    third: SignatureColumn
) {
    const secondSize = second.size;
    const thirdSize = third.size;
    const size = first.size * secondSize * thirdSize;
    // Per id of the earlier columns and values of the columns (row-major): the id of their combination, or -1
    const table = new Int32Array(count * size).fill(-1);
    const firstEntries: number[] = [];
    const firstValues = first.values;
    const secondValues = second.values;
    const thirdValues = third.values;

    for (let i = 0; i < ids.length; i++) {
        const valuesCombination = (firstValues[i] * secondSize + secondValues[i]) * thirdSize + thirdValues[i];
        const combination = sourceIds[i] * size + valuesCombination;
        let id = table[combination];

        if (id === -1) {
            id = firstEntries.push(i) - 1;
            table[combination] = id;
        }

        ids[i] = id;
    }

    return firstEntries;
}

// Replaces ids of `count` combinations of earlier columns by the ids of their combinations with the values of two
// columns, numbered in the order of their first entries; returns the first entry of every combination
function combinePair(
    sourceIds: ColumnValues,
    ids: Uint32Array,
    count: number,
    left: SignatureColumn,
    right: SignatureColumn
) {
    const rightSize = right.size;
    const size = left.size * rightSize;
    // Per id of the earlier columns and values of the columns (row-major): the id of their combination, or -1
    const table = new Int32Array(count * size).fill(-1);
    const firstEntries: number[] = [];
    const leftValues = left.values;
    const rightValues = right.values;
    const leftSamples = left.samples;
    const rightSamples = right.samples;

    // PERF: Separate loops for event and sample values keep the per-event loop free of a branch
    if (leftSamples !== null && rightSamples !== null) {
        for (let i = 0; i < ids.length; i++) {
            const valuesCombination = leftValues[leftSamples[i]] * rightSize + rightValues[rightSamples[i]];
            const combination = sourceIds[i] * size + valuesCombination;
            let id = table[combination];

            if (id === -1) {
                id = firstEntries.push(i) - 1;
                table[combination] = id;
            }

            ids[i] = id;
        }
    } else {
        for (let i = 0; i < ids.length; i++) {
            const combination = sourceIds[i] * size + leftValues[i] * rightSize + rightValues[i];
            let id = table[combination];

            if (id === -1) {
                id = firstEntries.push(i) - 1;
                table[combination] = id;
            }

            ids[i] = id;
        }
    }

    return firstEntries;
}

// Replaces ids of `count` combinations of earlier columns by the ids of their combinations with a column's values,
// numbered in the order of their first entries; returns the first entry of every combination
function combineColumn(
    sourceIds: ColumnValues,
    ids: Uint32Array,
    count: number,
    values: ColumnValues,
    samples: Uint32Array | null,
    size: number
) {
    // Per id of the earlier columns and value of the column (row-major): the id of their combination, or -1
    const table = new Int32Array(count * size).fill(-1);
    const firstEntries: number[] = [];

    // PERF: Separate loops for event and sample values keep the per-event loop free of a branch
    if (samples === null) {
        for (let i = 0; i < ids.length; i++) {
            const combination = sourceIds[i] * size + values[i];
            let id = table[combination];

            if (id === -1) {
                id = firstEntries.push(i) - 1;
                table[combination] = id;
            }

            ids[i] = id;
        }
    } else {
        for (let i = 0; i < ids.length; i++) {
            const combination = sourceIds[i] * size + values[samples[i]];
            let id = table[combination];

            if (id === -1) {
                id = firstEntries.push(i) - 1;
                table[combination] = id;
            }

            ids[i] = id;
        }
    }

    return firstEntries;
}

function signatureValues(column: SignatureColumn, events: Uint32Array) {
    const { values, samples } = column;
    const result = new Uint32Array(events.length);

    for (let i = 0; i < events.length; i++) {
        result[i] = samples === null
            ? values[events[i]]
            : values[samples[events[i]]];
    }

    return result;
}
