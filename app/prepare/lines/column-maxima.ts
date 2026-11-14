import type { ProfileLine, ProfileLineAttribute } from './types.js';
import type { PopulationFiltered } from '../computations/population.js';
import type { EventSignatures, RangeRecords } from './event-signatures.js';
import { lowerBound } from '../computations/misc.js';
import { lineWindowExtent } from './range.js';

// Histograms of a line window show columns whose duration doubles with every merge level, so the columns of all
// durations over the line viewport are one hierarchy: a column of a level holds two columns of the level below.
// Rows of attribute values scale to the highest columns of their level over the whole viewport, of their value and
// of the total; columns are taken for the values whose rows are shown. Columns of a level add to the column of the
// next level holding them when they're complete, so weights added to the columns of a level give the highest columns
// of every level above it. The columns of every level are taken in one pass over the segments of the axis holding
// events whole (cells of the line's own axis, targets of another line's axis) from the level of the segments, the
// floor: below it a column holds a part of a segment at most.

// Cells of a line per column, at least, for columns whose edges cross cells
const CROSSED_CELLS_PER_COLUMN = 16;

// Roundings of coordinates giving a column start or a duration, each within a unit of the last place
const COORDINATE_ROUNDINGS = 4;

// The highest columns of one value (or of all values) at the levels from a base level to a top level: weights add
// to the columns of the base level in their order, a column is complete when a later one starts outside it, and adds
// to the column of the level above holding it
class ColumnFolds {
    readonly maxima: Float64Array;
    // The base column weights add to, and per level the weight of the complete columns of the column holding it
    #column = -1;
    readonly #sums: Float64Array;
    readonly #holds: Uint8Array;
    // The base column parts were added to last, in absolute coordinates
    #from = Infinity;
    #to = -Infinity;

    constructor(
        readonly baseLevel: number,
        topLevel: number,
        readonly duration: number,
        readonly origin: number
    ) {
        this.maxima = new Float64Array(topLevel - baseLevel + 1);
        this.#sums = new Float64Array(this.maxima.length);
        this.#holds = new Uint8Array(this.maxima.length);
    }

    maximum(level: number) {
        return this.maxima[level - this.baseLevel];
    }

    // A weight in a column of the base level, counted from the origin
    add(column: number, weight: number) {
        if (this.#column !== column) {
            if (this.#column !== -1) {
                this.#complete(commonLevel(this.#column, column));
            }

            this.#column = column;
        }

        this.#sums[0] += weight;
    }

    // A part [start, end) of an event on the axis adds its parts in the base columns it crosses
    addPart(start: number, end: number) {
        const { duration } = this;

        // PERF: Most parts are within the column of the part before them
        if (start >= this.#from && end <= this.#to) {
            this.#sums[0] += end - start;
            return;
        }

        const from = start - this.origin;
        const to = end - this.origin;
        const first = Math.floor(from / duration);

        for (let i = first; i === first || i < to / duration; i++) {
            this.add(i, Math.min(to, (i + 1) * duration) - Math.max(from, i * duration));
        }

        this.#from = this.origin + this.#column * duration;
        this.#to = this.#from + duration;
    }

    // Completes the columns of every level. A column holding a single complete column is as high as it, and the
    // highest columns don't fall at coarser levels, so a column is kept at the finest level it is complete at only
    // and every level takes the highest columns of the levels below it
    finish() {
        const { maxima } = this;

        if (this.#column !== -1) {
            this.#complete(Infinity);
            this.#column = -1;
        }

        for (let i = 1; i < maxima.length; i++) {
            maxima[i] = Math.max(maxima[i], maxima[i - 1]);
        }

        return this;
    }

    // The columns holding the base column below a level are complete: a column adds to the column above it, which
    // is complete with it when it holds other complete columns; the column of the level adds them
    #complete(level: number) {
        const { maxima } = this;
        const sums = this.#sums;
        const holds = this.#holds;
        let sum = sums[0];

        sums[0] = 0;
        maxima[0] = Math.max(maxima[0], sum);

        for (let i = 1; i < level && i < sums.length; i++) {
            if (holds[i] === 1) {
                sum += sums[i];
                sums[i] = 0;
                holds[i] = 0;
                maxima[i] = Math.max(maxima[i], sum);
            }
        }

        if (level < sums.length) {
            sums[level] += sum;
            holds[level] = 1;
        }
    }
}

// The level of the first column holding both columns of the base level (non-negative integers): the length of the
// bits they differ in
function commonLevel(a: number, b: number) {
    const high = Math.floor(a / 0x100000000) ^ Math.floor(b / 0x100000000);

    return high !== 0
        ? 64 - Math.clz32(high)
        : 32 - Math.clz32(a ^ b);
}

// The axis of the columns of a hierarchy: the floor, the level of its segments (null when the whole events are its
// segments, on a line without cells), whether its columns hold no more than their duration (an axis of lengths of
// events, as the line's own axis is), and the pass adding the events of walks and the total to the columns of a level
type ColumnsAxis = {
    floorLevel: number | null;
    bounded: boolean;
    addColumns(walks: AttributeWalk[], total: ColumnFolds | null, duration: number): void;
};

// The line's own axis: its cells, or its events on a line too small to have cells
function ownAxis(line: ProfileLine, viewport: PopulationFiltered, topLevel: number, duration: number, origin: number) {
    const signatures = line.signatures!;
    const accepted = signatureAcceptance(line, viewport);
    const { cumulative, cumulativeEnd } = viewport.population;
    const cells = signatures.cellRecords(cumulative, cumulativeEnd);
    const floorLevel = cells !== null
        ? cellLevel(cells, cumulativeEnd, topLevel, duration, origin)
        : null;
    const addColumns = (walks: AttributeWalk[], total: ColumnFolds | null, levelDuration: number) =>
        addCellColumns(walks, total, signatures, cells, accepted, viewport, levelDuration, origin);

    return {
        floorLevel,
        bounded: true,
        addColumns
    };
}

// Another line's axis the line's events are mapped onto in order: the targets of its events
function mappedAxis(
    line: ProfileLine,
    viewport: PopulationFiltered,
    mapping: Uint32Array,
    axisViewport: PopulationFiltered,
    duration: number,
    origin: number
) {
    const signatures = line.signatures!;
    const accepted = signatureAcceptance(line, viewport);
    const addColumns = (walks: AttributeWalk[], total: ColumnFolds | null, levelDuration: number) =>
        addMappedColumns(walks, total, signatures, accepted, viewport, mapping, axisViewport, levelDuration, origin);

    return {
        floorLevel: Math.min(0, targetLevel(axisViewport, duration)),
        bounded: false,
        addColumns
    };
}

// Column maxima take the acceptance of events from their signatures: every filter of a line is a column of its
// signatures, and the viewport population of a line has no constraints beyond its filters
function signatureAcceptance(line: ProfileLine, viewport: PopulationFiltered) {
    return line.signatures!.acceptance(viewport)!;
}

// The highest columns of the levels of a hierarchy on an axis, of the values whose rows are shown and of their total.
// Folds take the columns of every level from the floor up in one pass, values shown later in a pass of their own.
// Below the floor a column holds a part of a segment at most: its highest column is the one of the floor, and on an
// axis of lengths no more than its duration, a bound rather than the highest column. On a line without cells the
// folds are taken from the level read, and from a finer level read again
class Columns {
    readonly #attributes: ProfileLineAttribute[] = [];
    // Per attribute: values whose rows are shown, and the folds of their columns (none for values not taken yet)
    readonly #shown: Uint8Array[] = [];
    readonly #folds: (ColumnFolds | null)[][] = [];
    #total: ColumnFolds | null = null;
    #baseLevel = Infinity;

    constructor(
        readonly axis: ColumnsAxis,
        readonly topLevel: number,
        readonly duration: number,
        readonly origin: number
    ) {}

    addAttribute(attribute: ProfileLineAttribute, shown: Uint8Array) {
        this.#attributes.push(attribute);
        this.#shown.push(shown);
        this.#folds.push(new Array(attribute.dict.length).fill(null));
    }

    total(level: number) {
        this.#take(level);

        return this.#maximum(this.#total!, level);
    }

    // The highest column of a value of an attribute (by their indices)
    track(index: number, group: number, level: number) {
        this.#take(level);

        return this.#maximum(this.#folds[index][group]!, level);
    }

    #maximum(folds: ColumnFolds, level: number) {
        const maximum = folds.maximum(Math.min(Math.max(level, this.#baseLevel), this.topLevel));

        if (level < this.#baseLevel && this.axis.bounded) {
            return Math.min(maximum, this.duration * 2 ** level);
        }

        return maximum;
    }

    // Folds of the total and of the values shown and not taken yet, all of them again from a finer base level
    #take(level: number) {
        const baseLevel = this.axis.floorLevel ?? Math.min(level, this.#baseLevel);
        const baseDuration = this.duration * 2 ** baseLevel;
        const walks: AttributeWalk[] = [];

        if (baseLevel < this.#baseLevel) {
            this.#baseLevel = baseLevel;
            this.#total = null;

            for (let i = 0; i < this.#folds.length; i++) {
                this.#folds[i].fill(null);
            }
        }

        const total = this.#total === null
            ? new ColumnFolds(baseLevel, this.topLevel, baseDuration, this.origin)
            : null;

        for (let i = 0; i < this.#attributes.length; i++) {
            const shown = this.#shown[i];
            const folds: (ColumnFolds | null)[] = [];

            for (let j = 0; j < shown.length; j++) {
                const taken = this.#folds[i][j] !== null;

                folds.push(shown[j] === 1 && !taken
                    ? new ColumnFolds(baseLevel, this.topLevel, baseDuration, this.origin)
                    : null);
            }

            const walk = attributeWalk(i, this.#attributes[i], folds);

            if (walk !== null) {
                walks.push(walk);
            }
        }

        if (walks.length === 0 && total === null) {
            return;
        }

        this.axis.addColumns(walks, total, baseDuration);

        for (let i = 0; i < walks.length; i++) {
            const { index, folds, walked } = walks[i];

            for (let j = 0; j < walked.length; j++) {
                this.#folds[index][walked[j]] = folds[walked[j]]!.finish();
            }
        }

        this.#total = total?.finish() ?? this.#total;
    }
}

// A walk of the values of an attribute (by its index): their folds (none for values not walked) and the ones walked,
// the keys of events (the signatures of events, see keyLineBySignatures) with the folds of their codes by their
// entries, and the sums of the records of a segment per value
type AttributeWalk = {
    index: number;
    folds: (ColumnFolds | null)[];
    walked: number[];
    keys: ArrayLike<number>;
    entries: ArrayLike<number>;
    codeFolds: (ColumnFolds | null)[];
    sums: Float64Array;
};

// A walk of an attribute's values with folds, null when none has them
function attributeWalk(
    index: number,
    attribute: ProfileLineAttribute,
    folds: (ColumnFolds | null)[]
): AttributeWalk | null {
    const walked: number[] = [];

    for (let i = 0; i < folds.length; i++) {
        if (folds[i] !== null) {
            walked.push(i);
        }
    }

    if (walked.length === 0) {
        return null;
    }

    return {
        index,
        folds,
        walked,
        keys: attribute.keys,
        entries: attribute.entries,
        codeFolds: codeFolds(attribute.entries, folds),
        sums: new Float64Array(folds.length)
    };
}

// The folds of codes by their entries
// PERF: A loop, as Array.from with a function takes about half a millisecond for the entries of tens of thousands
// of signatures
function codeFolds(entries: ArrayLike<number>, folds: (ColumnFolds | null)[]) {
    const result: (ColumnFolds | null)[] = new Array(entries.length);

    for (let i = 0; i < entries.length; i++) {
        result[i] = folds[entries[i]];
    }

    return result;
}

// Cells of events within a range and a column add the accepted records of their signatures to the folds of their
// values and to the total when given; the last event of such a cell can end beyond the column, its part beyond adds to
// the columns it covers. Events of other cells, and of a line without cells, add their parts one by one
function addCellColumns(
    walks: AttributeWalk[],
    total: ColumnFolds | null,
    signatures: EventSignatures,
    cells: RangeRecords | null,
    accepted: Uint8Array,
    viewport: PopulationFiltered,
    duration: number,
    origin: number
) {
    const { values, cumulative, cumulativeEnd } = viewport.population;
    const { ids } = signatures;
    const starts = cells !== null
        ? cells.starts
        : Uint32Array.of(0, values.length);
    const ranges = viewport.ranges ?? [{ start: 0, end: cumulativeEnd }];

    for (let i = 0; i < ranges.length; i++) {
        const rangeStart = ranges[i].start;
        const rangeEnd = ranges[i].end;
        const rangeFirst = Math.max(0, lowerBound(cumulative, rangeStart, true) - 1);
        const rangeLast = lowerBound(cumulative, rangeEnd);
        let cell = lowerBound(starts, rangeFirst, true) - 1;

        for (let j = rangeFirst; j < rangeLast; cell++) {
            const cellEnd = starts[cell + 1];
            const last = cellEnd - 1;
            const column = Math.floor((cumulative[j] - origin) / duration);
            const cellWithin = (
                cells !== null &&
                j === starts[cell] &&
                cellEnd <= rangeLast &&
                cumulative[j] >= rangeStart &&
                Math.floor((cumulative[last] - origin) / duration) === column
            );

            if (cellEnd <= j) {
                continue;
            }

            // PERF: Cells within a column take the records of their signatures, not their events
            if (cellWithin) {
                const columnEnd = origin + (column + 1) * duration;
                const fullEnd = cumulative[last] + values[last];
                const lastEnd = Math.min(fullEnd, rangeEnd);
                const keptEnd = Math.min(lastEnd, columnEnd);

                const weight = addRecords(walks, cells, cell, accepted, column);

                total?.add(column, weight);

                // The records hold the last allocation of the cell whole: its part beyond the column or the range
                // leaves the column, and its part in the range beyond the column adds to the columns it covers
                if (accepted[ids[last]] === 1 && fullEnd > keptEnd) {
                    for (let k = 0; k < walks.length; k++) {
                        const lastFolds = walks[k].codeFolds[walks[k].keys[last]];

                        lastFolds?.add(column, keptEnd - fullEnd);

                        if (lastEnd > columnEnd) {
                            lastFolds?.addPart(columnEnd, lastEnd);
                        }
                    }

                    total?.add(column, keptEnd - fullEnd);

                    if (lastEnd > columnEnd) {
                        total?.addPart(columnEnd, lastEnd);
                    }
                }

                j = cellEnd;
                continue;
            }

            for (const end = Math.min(cellEnd, rangeLast); j < end; j++) {
                if (values[j] > 0 && accepted[ids[j]] === 1) {
                    let partStart = cumulative[j];
                    let partEnd = partStart + values[j];

                    if (partStart < rangeStart) {
                        partStart = rangeStart;
                    }

                    if (partEnd > rangeEnd) {
                        partEnd = rangeEnd;
                    }

                    for (let k = 0; k < walks.length; k++) {
                        walks[k].codeFolds[walks[k].keys[j]]?.addPart(partStart, partEnd);
                    }

                    total?.addPart(partStart, partEnd);
                }
            }
        }
    }
}

// The accepted records of a segment of the axis (a cell or a target) sum per value of every walk first, as signatures
// split a value into records by other attributes, so the folds of a value walked add a weight per segment; returns the
// weight of the records, the total adds it once per segment
function addRecords(
    walks: AttributeWalk[],
    records: RangeRecords,
    segment: number,
    accepted: Uint8Array,
    column: number
) {
    const { recordStarts, signatures, weights } = records;
    const recordsStart = recordStarts[segment];
    const recordsEnd = recordStarts[segment + 1];
    let weight = 0;

    if (walks.length === 0) {
        for (let i = recordsStart; i < recordsEnd; i++) {
            if (accepted[signatures[i]] === 1) {
                weight += weights[i];
            }
        }
    }

    for (let i = 0; i < walks.length; i++) {
        const { folds, walked, entries, sums } = walks[i];
        let walkWeight = 0;

        for (let j = recordsStart; j < recordsEnd; j++) {
            const signature = signatures[j];

            if (accepted[signature] === 1) {
                sums[entries[signature]] += weights[j];
                walkWeight += weights[j];
            }
        }

        // Every walk sums the same accepted records
        weight = walkWeight;

        for (let j = 0; j < walked.length; j++) {
            const group = walked[j];

            if (sums[group] !== 0) {
                folds[group]!.add(column, sums[group]);
                sums[group] = 0;
            }
        }
    }

    return weight;
}

// The level whose columns are no longer than the shortest target, columns of it and below hold a target at most
function targetLevel(axisViewport: PopulationFiltered, duration: number) {
    const { values } = axisViewport.population;
    let shortest = Infinity;

    for (let i = 0; i < values.length; i++) {
        if (values[i] > 0 && values[i] < shortest) {
            shortest = values[i];
        }
    }

    return Math.floor(Math.log2(shortest / duration));
}

// Events add to the columns of their targets: whole targets by the signature records of their events, events of
// targets cut by the coverage of the population and the covered parts of cut events one by one
function addMappedColumns(
    walks: AttributeWalk[],
    total: ColumnFolds | null,
    signatures: EventSignatures,
    accepted: Uint8Array,
    viewport: PopulationFiltered,
    mapping: Uint32Array,
    axisViewport: PopulationFiltered,
    duration: number,
    origin: number
) {
    const { sinkId, coverage, boundaryCuts } = viewport;
    const { values } = viewport.population;
    const { destination } = viewport.eventReader();
    const targetColumn = createTargetColumns(axisViewport, duration, origin);
    // Signature records of whole targets sum their events; the total takes their weight
    const records = signatures.targetRecords(mapping, axisViewport.population.values.length);
    const addEvent = (event: number, weight: number) => {
        const column = targetColumn(mapping[event]);

        if (column !== -1 && weight > 0 && destination(event) !== sinkId) {
            total?.add(column, weight);

            for (let i = 0; i < walks.length; i++) {
                walks[i].codeFolds[walks[i].keys[event]]?.add(column, weight);
            }
        }
    };
    const addEvents = (first: number, end: number) => {
        for (let i = first; i < end; i++) {
            addEvent(i, values[i]);
        }
    };
    const addTargets = (firstTarget: number, endTarget: number) => {
        for (let i = firstTarget; i < endTarget; i++) {
            const column = targetColumn(i);

            if (column !== -1) {
                const weight = addRecords(walks, records, i, accepted, column);

                total?.add(column, weight);
            }
        }
    };
    // Whole events [first, end): the targets between the targets of the first and the last event have all of their
    // events among them
    const addSpan = (first: number, end: number) => {
        const firstTarget = mapping[first];
        const lastTarget = mapping[end - 1];

        if (end - first < 2 || lastTarget - firstTarget < 2) {
            addEvents(first, end);
            return;
        }

        addEvents(first, records.starts[firstTarget + 1]);
        addTargets(firstTarget + 1, lastTarget);
        addEvents(records.starts[lastTarget], end);
    };
    let j = 0;

    for (let i = 0; i < coverage.length; i++) {
        const end = coverage[i][1];
        let first = coverage[i][0];

        for (; j < boundaryCuts.length && boundaryCuts[j].index < end; j++) {
            const cut = boundaryCuts[j];

            addSpan(first, cut.index);
            addEvent(cut.index, cut.covered);
            first = cut.index + 1;
        }

        addSpan(first, end);
    }
}

// Columns of targets on an axis: -1 for targets rejected by the axis population, out of its ranges or of no
// weight, as the sample of no time a profile ends with for allocations after it. Targets are read in
// nondecreasing order
function createTargetColumns(axisViewport: PopulationFiltered, duration: number, origin: number) {
    const { samples, sinkId, ranges } = axisViewport;
    const { values, cumulative } = axisViewport.population;
    let rangeIndex = 0;

    return (target: number) => {
        if (values[target] === 0 || samples[target] === sinkId) {
            return -1;
        }

        const coordinate = cumulative[target];

        if (ranges !== null) {
            while (rangeIndex < ranges.length && ranges[rangeIndex].end <= coordinate) {
                rangeIndex++;
            }

            if (rangeIndex === ranges.length || coordinate < ranges[rangeIndex].start) {
                return -1;
            }
        }

        return Math.floor((coordinate - origin) / duration);
    };
}

// The finest level whose columns hold whole cells of the line; columns whose edges cross cells walk the events of
// the crossed cells, so they hold many cells
function cellLevel(cells: RangeRecords, cumulativeEnd: number, topLevel: number, duration: number, origin: number) {
    const cellLength = cumulativeEnd / (cells.starts.length - 1);
    const onCells = (value: number) => Math.abs(value / cellLength - Math.round(value / cellLength)) < 1e-6;
    let level = topLevel;

    while (level > -Infinity) {
        const levelDuration = duration * 2 ** (level - 1);
        const holdsCells = onCells(origin) && onCells(levelDuration)
            ? levelDuration >= cellLength
            : levelDuration >= cellLength * CROSSED_CELLS_PER_COLUMN;

        if (!holdsCells) {
            return level;
        }

        level--;
    }

    return level;
}

// Columns of the levels of a duration from an origin (absolute coordinates): a level's columns are 2^level times as
// long, the top level has a single column over the extent
type Hierarchy = {
    origin: number;
    duration: number;
    columns: Columns;
};

// The highest columns of the attributes of a line's viewport population at the levels of its histograms, on the
// line's own axis or on the axis of another line its events are mapped onto. Attributes are registered by their
// readers and computed on the first read after a change of the populations, a later one with the hierarchy;
// levels are kept until the next change
export class LineColumnMaxima {
    #attributes: ProfileLineAttribute[] = [];
    // Per attribute: values whose rows are shown, declared by views before their rows are read, so that a walk takes
    // all of them
    #shown: Uint8Array[] = [];
    #hierarchy: Hierarchy | null = null;

    constructor(
        readonly line: ProfileLine,
        readonly viewport: PopulationFiltered,
        readonly axisLine: ProfileLine,
        readonly axisViewport: PopulationFiltered,
        readonly mapping: Uint32Array | null
    ) {
        const reset = () => {
            this.#hierarchy = null;
        };

        viewport.subscribe(reset);

        if (axisViewport !== viewport) {
            axisViewport.subscribe(reset);
        }
    }

    register(attribute: ProfileLineAttribute) {
        if (!this.#attributes.includes(attribute)) {
            this.#attributes.push(attribute);
            this.#shown.push(new Uint8Array(attribute.dict.length));
            this.#hierarchy?.columns.addAttribute(attribute, this.#shown[this.#shown.length - 1]);
        }
    }

    // A row of a value of an attribute (by its index) is shown
    show(attribute: ProfileLineAttribute, group: number) {
        this.register(attribute);
        this.#shown[this.#attributes.indexOf(attribute)][group] = 1;
    }

    // The highest column of a duration starting at a column start (absolute coordinates) over the viewport, of all
    // the accepted events
    total(duration: number, columnStart: number) {
        const { columns, level } = this.#hierarchyLevel(duration, columnStart);

        return columns.total(level);
    }

    // The highest column of a value of an attribute (by its index) whose row is shown
    track(attribute: ProfileLineAttribute, group: number, duration: number, columnStart: number) {
        const { columns, level } = this.#hierarchyLevel(duration, columnStart);

        return columns.track(this.#attributes.indexOf(attribute), group, level);
    }

    #hierarchyLevel(duration: number, columnStart: number) {
        let hierarchy = this.#hierarchy;
        let level = hierarchy !== null
            ? hierarchyLevel(hierarchy, duration, columnStart)
            : null;

        if (hierarchy === null || level === null) {
            hierarchy = this.#createHierarchy(duration, columnStart);
            this.#hierarchy = hierarchy;
            level = 0;
        }

        return {
            columns: hierarchy.columns,
            level
        };
    }

    #createHierarchy(duration: number, columnStart: number): Hierarchy {
        const extent = lineWindowExtent(this.axisLine);
        let topDuration = duration;
        let topLevel = 0;

        while (topDuration < extent.end - extent.start) {
            topDuration *= 2;
        }

        // An origin before the extent at a multiple of the duration of every level from the column start
        const origin = columnStart - Math.ceil((columnStart - extent.start) / topDuration) * topDuration;
        const axisOrigin = this.axisLine.range.frame.rebaseValue(origin);

        while (duration * 2 ** topLevel < extent.end - origin) {
            topLevel++;
        }

        const axis = this.mapping === null
            ? ownAxis(this.line, this.viewport, topLevel, duration, axisOrigin)
            : mappedAxis(this.line, this.viewport, this.mapping, this.axisViewport, duration, axisOrigin);
        const columns = new Columns(axis, topLevel, duration, axisOrigin);

        for (let i = 0; i < this.#attributes.length; i++) {
            columns.addAttribute(this.#attributes[i], this.#shown[i]);
        }

        return {
            origin,
            duration,
            columns
        };
    }

}

// The level of a duration from a column start in a hierarchy, null when its columns aren't columns of it. Column
// starts and durations are computed from coordinates, so they are known to a few units of the last place of the
// coordinates: off the columns of a hierarchy by no more they are columns of it, as columns of a hierarchy built
// for them are
function hierarchyLevel(hierarchy: Hierarchy, duration: number, columnStart: number) {
    const { origin } = hierarchy;
    const level = Math.round(Math.log2(duration / hierarchy.duration));
    const levelDuration = hierarchy.duration * 2 ** level;
    const column = Math.round((columnStart - origin) / levelDuration);
    const precision = COORDINATE_ROUNDINGS * Number.EPSILON * Math.max(Math.abs(columnStart), Math.abs(origin));

    if (
        Math.abs(levelDuration - duration) > Math.max(duration * 1e-9, precision) ||
        Math.abs(origin + column * levelDuration - columnStart) > Math.max(duration * 1e-6, precision)
    ) {
        return null;
    }

    return level;
}

// The column maxima of a line's viewport population on an axis, kept with the line's population: one per axis
// population it's read on
const lineColumnMaxima = new WeakMap<PopulationFiltered, Map<PopulationFiltered, LineColumnMaxima>>();

// Null when the line's events have no positions on the axis: neither its own axis nor a mapping to the axis line's
// events, or a mapping out of their order; and for a line without signatures, which column maxima walk by
export function getLineColumnMaxima(
    line: ProfileLine,
    viewport: PopulationFiltered,
    axisLine: ProfileLine,
    axisViewport: PopulationFiltered
) {
    const mapping = line !== axisLine
        ? line.mappings[axisLine.type]
        : null;

    if (mapping === undefined || line.signatures === null) {
        return null;
    }

    if (mapping !== null && !mapping.nondecreasing) {
        return null;
    }

    let byAxis = lineColumnMaxima.get(viewport);

    if (byAxis === undefined) {
        byAxis = new Map();
        lineColumnMaxima.set(viewport, byAxis);
    }

    let maxima = byAxis.get(axisViewport);

    if (maxima === undefined) {
        maxima = new LineColumnMaxima(line, viewport, axisLine, axisViewport, mapping?._mapping ?? null);
        byAxis.set(axisViewport, maxima);
    }

    return maxima;
}
