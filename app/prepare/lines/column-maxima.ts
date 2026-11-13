import type { ProfileLine, ProfileLineAttribute } from './types.js';
import type { PopulationFiltered } from '../computations/population.js';
import type { Range } from '../computations/coordinates.js';
import type { EventSignatures, RangeRecords } from './event-signatures.js';
import { findCumulativeBoundary } from '../computations/population.js';
import { lowerBound } from '../computations/misc.js';
import { lineWindowExtent } from './range.js';

// Histograms of a line window show columns whose duration doubles with every merge level, so the columns of all
// durations over the line viewport are one hierarchy: a column of a level holds two columns of the level below.
// Rows of attribute values scale to the highest columns of their level over the whole viewport, of their value and
// of the total; columns are taken for the values whose rows are shown. Columns of a level add to the column of the
// next level holding them when they're complete, so weights added to the columns of a level give the highest columns
// of every level above it.

// Levels a walk folds below the requested one: a value's highest columns on its own axis change down to the level its
// runs cover a column of, a few levels below the cells for values of many events; zooming in takes a walk then only
// every few levels
const LEVELS_AHEAD = 4;

// Cells of a line per column, at least, for columns whose edges cross cells
const CROSSED_CELLS_PER_COLUMN = 16;

// The highest columns of a level, of the values of every attribute and of their total; NaN for ones not taken yet.
// A walk of a value ending at a column reaching a bound gives columns its highest ones are at or above
type LevelMaxima = {
    total: number;
    tracks: Float64Array[];
    atLeast: Float64Array[];
};

// The highest columns of one value (or of all values) at the levels from a base level to a top level: weights add
// to the columns of the base level in their order, a column is complete when a later one starts outside it, and adds
// to the column of the level above holding it. Parts placed on the axis give the longest run of parts continuing one
// another too
class ColumnFolds {
    readonly maxima: Float64Array;
    longest = 0;
    // Columns of the base level with weights (a bit per column), when kept
    readonly held: Uint8Array | null;
    // The base column weights add to, and per level the weight of the complete columns of the column holding it
    #column = -1;
    readonly #sums: Float64Array;
    readonly #holds: Uint8Array;
    // The highest complete column
    #highest = 0;
    // The base column parts were added to last, in absolute coordinates
    #from = Infinity;
    #to = -Infinity;
    #runStart = 0;
    #runEnd = -1;

    constructor(
        readonly baseLevel: number,
        topLevel: number,
        readonly duration: number,
        readonly origin: number,
        keepsHeld = false
    ) {
        this.maxima = new Float64Array(topLevel - baseLevel + 1);
        this.held = keepsHeld
            ? new Uint8Array(Math.ceil(2 ** (topLevel - baseLevel) / 8))
            : null;
        this.#sums = new Float64Array(this.maxima.length);
        this.#holds = new Uint8Array(this.maxima.length);
    }

    maximum(level: number) {
        return this.maxima[level - this.baseLevel];
    }

    // The highest complete column of any level, the top level has a column as high at least
    get topMaximum() {
        return this.#highest;
    }

    // A weight in a column of the base level, counted from the origin
    add(column: number, weight: number) {
        if (this.#column !== column) {
            if (this.#column !== -1) {
                this.#complete(commonLevel(this.#column, column));
            }

            this.#column = column;

            if (this.held !== null) {
                this.held[column >> 3] |= 1 << (column & 7);
            }
        }

        this.#sums[0] += weight;
    }

    // A part [start, end) of an event on the axis adds its parts in the base columns it crosses
    addPart(start: number, end: number) {
        const { duration } = this;

        if (start !== this.#runEnd) {
            this.#runStart = start;
        }

        this.#runEnd = end;
        this.longest = Math.max(this.longest, end - this.#runStart);

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

        this.#highest = Math.max(this.#highest, sum);

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

// Levels taken so far, a level with the highest columns of the attributes added after it was taken
function takeLevel(levels: Map<number, LevelMaxima>, level: number, attributes: ProfileLineAttribute[]) {
    let levelMaxima = levels.get(level);

    if (levelMaxima === undefined) {
        levelMaxima = {
            total: NaN,
            tracks: [],
            atLeast: []
        };
        levels.set(level, levelMaxima);
    }

    for (let i = levelMaxima.tracks.length; i < attributes.length; i++) {
        levelMaxima.tracks.push(new Float64Array(attributes[i].dict.length).fill(NaN));
        levelMaxima.atLeast.push(new Float64Array(attributes[i].dict.length).fill(NaN));
    }

    return levelMaxima;
}

// The highest columns of the levels of the folds of a value walked to its last event, or columns its highest ones are
// at or above when the walk ended at a bound
function keepFolds(
    levels: Map<number, LevelMaxima>,
    attributes: ProfileLineAttribute[],
    index: number,
    group: number,
    folds: ColumnFolds,
    complete: boolean
) {
    for (let i = folds.baseLevel; i < folds.baseLevel + folds.maxima.length; i++) {
        const levelMaxima = takeLevel(levels, i, attributes);
        const maxima = complete
            ? levelMaxima.tracks[index]
            : levelMaxima.atLeast[index];

        maxima[group] = folds.maximum(i);
    }
}

// The highest columns of a line's events on its own axis. Levels of columns holding whole cells of the line take the
// signature records of the cells, walking events only in cells crossed by a column edge. Finer levels are taken for
// values whose rows are shown, for a bound their rows show their own scale below: a value covering a column of cells
// whole, or with a run covering a column, covers a column of the level whole, and a value whose highest column to its
// duration reaches the bound at a coarser level reaches it at finer ones. Other values whose rows are shown are walked
// by their events together, a walk folding the levels from some levels below the requested one up to it
class OwnColumns {
    readonly #attributes: ProfileLineAttribute[] = [];
    // Per attribute: the folds of the levels of cells of every value (none for values signatures don't keep), values
    // whose rows are shown, and the longest runs of values measured by walks
    readonly #cellFolds: (ColumnFolds[] | null)[] = [];
    readonly #shown: Uint8Array[] = [];
    readonly #longest: Float64Array[] = [];
    #cellTotal: ColumnFolds | null = null;
    #totalLongest = 0;
    readonly #cellLevel: number;
    readonly #cells: RangeRecords | null;
    readonly #accepted: Uint8Array | null;
    readonly #ids: Uint32Array | null;
    readonly #ranges: readonly Range[];
    readonly #levels = new Map<number, LevelMaxima>();

    constructor(
        readonly line: ProfileLine,
        readonly viewport: PopulationFiltered,
        readonly topLevel: number,
        readonly duration: number,
        readonly origin: number
    ) {
        const { signatures } = line;
        const { cumulative, cumulativeEnd } = viewport.population;

        this.#accepted = signatures?.acceptance(viewport) ?? null;
        this.#ids = signatures?.ids ?? null;
        this.#cells = signatures !== null && this.#accepted !== null
            ? signatures.cellRecords(cumulative, cumulativeEnd)
            : null;
        this.#cellLevel = this.#cells !== null
            ? cellLevel(this.#cells, cumulativeEnd, topLevel, duration, origin)
            : Infinity;
        this.#ranges = viewport.ranges ?? [{ start: 0, end: cumulativeEnd }];
    }

    addAttribute(attribute: ProfileLineAttribute, shown: Uint8Array) {
        const signatureGroups = this.#cells !== null
            ? this.line.signatures!.valuesOf(attribute.values)
            : null;

        this.#attributes.push(attribute);
        // Values of attributes signatures don't keep, as the owner of an allocation, are walked on every level
        this.#cellFolds.push(signatureGroups !== null
            ? this.#cellFoldsOf(signatureGroups, attribute.dict.length)
            : null);
        this.#shown.push(shown);
        this.#longest.push(new Float64Array(attribute.dict.length));
    }

    total(level: number) {
        const levelMaxima = takeLevel(this.#levels, level, this.#attributes);
        const duration = this.duration * 2 ** level;
        const cellTotal = this.#cellTotal;

        if (cellTotal !== null && level >= this.#cellLevel) {
            return cellTotal.maximum(Math.min(level, this.topLevel));
        }

        // Events of a column of cells covering it whole cover the finer columns in it, as does a run covering a column
        if (cellTotal !== null && cellTotal.maximum(this.#cellLevel) >= cellTotal.duration) {
            return duration;
        }

        if (this.#totalLongest >= 2 * duration) {
            return duration;
        }

        if (Number.isNaN(levelMaxima.total)) {
            const folds = this.#walkFolds(level);

            addEventParts([folds], null, this.viewport, this.#ranges, this.#accepted, this.#ids, Infinity);
            folds.finish();
            this.#totalLongest = Math.max(this.#totalLongest, folds.longest);

            for (let i = folds.baseLevel; i <= level; i++) {
                takeLevel(this.#levels, i, this.#attributes).total = folds.maximum(i);
            }
        }

        return levelMaxima.total;
    }

    // The highest column of a value of an attribute (by their indices), or a column at or above a bound
    track(index: number, group: number, level: number, bound: number) {
        let maximum = this.#knownMaximum(index, group, level, bound);

        if (Number.isNaN(maximum)) {
            this.#walk(index, level, bound);
            maximum = this.#knownMaximum(index, group, level, bound);
        }

        return maximum;
    }

    // The highest column of a value known without a walk, or a column at or above the bound; NaN when unknown
    #knownMaximum(index: number, group: number, level: number, bound: number) {
        const cellFolds = this.#cellFolds[index]?.[group] ?? null;
        const duration = this.duration * 2 ** level;
        let lower = 0;

        if (cellFolds !== null && level >= this.#cellLevel) {
            return cellFolds.maximum(Math.min(level, this.topLevel));
        }

        // A value covering a column of cells whole covers the finer columns in it, as does a run covering a column
        if (cellFolds !== null && cellFolds.maximum(this.#cellLevel) >= cellFolds.duration) {
            return duration;
        }

        if (this.#longest[index][group] >= 2 * duration) {
            return duration;
        }

        if (cellFolds !== null) {
            lower = cellFolds.maximum(this.#cellLevel) / 2 ** (this.#cellLevel - level);
        }

        // A column holds two columns of the level below, one of them with half of it at least, and is held by
        // a column of the level above
        for (const [takenLevel, levelMaxima] of this.#levels) {
            // Levels taken before the attribute was added have no columns of it
            const maximum = levelMaxima.tracks[index]?.[group] ?? NaN;
            const column = Number.isNaN(maximum)
                ? levelMaxima.atLeast[index]?.[group] ?? NaN
                : maximum;

            if (takenLevel === level && !Number.isNaN(maximum)) {
                return maximum;
            }

            if (column > 0) {
                lower = Math.max(lower, takenLevel > level
                    ? column / 2 ** (takenLevel - level)
                    : column);
            }
        }

        return lower >= bound
            ? lower
            : NaN;
    }

    // Values shown and unknown at a level are walked together. The share of the duration a value's highest column
    // has doesn't fall at finer levels, so a value whose column of the level reaches the bound reaches it at the
    // levels of the walk below, and its walk ends there
    #walk(index: number, level: number, bound: number) {
        const longest = this.#longest[index];
        const folds = this.#unknownFolds(index, level, bound);
        const walked = folds.slice();

        addEventParts(
            walked,
            this.#attributes[index].values,
            this.viewport,
            this.#walkRanges(index, folds),
            this.#accepted,
            this.#ids,
            bound
        );

        for (let i = 0; i < folds.length; i++) {
            const groupFolds = folds[i];

            if (groupFolds !== null) {
                groupFolds.finish();
                longest[i] = Math.max(longest[i], groupFolds.longest);
                keepFolds(this.#levels, this.#attributes, index, i, groupFolds, walked[i] !== null);
            }
        }
    }

    // The folds of the values of an attribute (by its index) shown and unknown at a level, none for other values
    #unknownFolds(index: number, level: number, bound: number) {
        const shown = this.#shown[index];
        const folds: (ColumnFolds | null)[] = [];

        for (let i = 0; i < shown.length; i++) {
            folds.push(shown[i] === 1 && Number.isNaN(this.#knownMaximum(index, i, level, bound))
                ? this.#walkFolds(level)
                : null);
        }

        return folds;
    }

    #walkFolds(level: number) {
        const baseLevel = level - LEVELS_AHEAD;

        return new ColumnFolds(baseLevel, level, this.duration * 2 ** baseLevel, this.origin);
    }

    // The folds of the levels of cells of the values of an attribute, keeping the columns holding them; the total is
    // folded with the first attribute signatures keep
    #cellFoldsOf(signatureGroups: Uint32Array, groupCount: number) {
        const folds: ColumnFolds[] = [];
        const cellDuration = this.duration * 2 ** this.#cellLevel;
        const total = this.#cellTotal === null
            ? new ColumnFolds(this.#cellLevel, this.topLevel, cellDuration, this.origin)
            : null;

        for (let i = 0; i < groupCount; i++) {
            folds.push(new ColumnFolds(this.#cellLevel, this.topLevel, cellDuration, this.origin, true));
        }

        addCellColumns(
            folds,
            signatureGroups,
            total,
            this.line.signatures!,
            this.#cells!,
            this.#accepted!,
            this.viewport,
            this.origin
        );

        for (let i = 0; i < groupCount; i++) {
            folds[i].finish();
        }

        this.#cellTotal = total?.finish() ?? this.#cellTotal;

        return folds;
    }

    // The ranges a walk of values takes events of: the columns of cells holding them, the whole ranges for values
    // without cells
    #walkRanges(index: number, folds: (ColumnFolds | null)[]) {
        const cellFolds = this.#cellFolds[index];

        if (cellFolds === null) {
            return this.#ranges;
        }

        const held = new Uint8Array(cellFolds[0].held!.length);

        for (let i = 0; i < folds.length; i++) {
            if (folds[i] !== null) {
                for (let j = 0; j < held.length; j++) {
                    held[j] |= cellFolds[i].held![j];
                }
            }
        }

        return heldRanges(held, this.duration * 2 ** this.#cellLevel, this.origin, this.#ranges);
    }
}

// Ranges of the parts of columns of a duration (from an origin, a bit per column) in ranges, adjacent columns merged
function heldRanges(held: Uint8Array, duration: number, origin: number, ranges: readonly Range[]) {
    const columnCount = held.length * 8;
    const columnHeld = (column: number) => (held[column >> 3] & (1 << (column & 7))) !== 0;
    const parts: Range[] = [];
    let rangeIndex = 0;

    for (let i = 0; i < columnCount; i++) {
        if (!columnHeld(i)) {
            continue;
        }

        const start = origin + i * duration;

        while (i + 1 < columnCount && columnHeld(i + 1)) {
            i++;
        }

        const end = origin + (i + 1) * duration;

        while (rangeIndex < ranges.length && ranges[rangeIndex].end <= start) {
            rangeIndex++;
        }

        for (let j = rangeIndex; j < ranges.length && ranges[j].start < end; j++) {
            parts.push({
                start: Math.max(start, ranges[j].start),
                end: Math.min(end, ranges[j].end)
            });
        }
    }

    return parts;
}

// Accepted events of weight of the ranges add their parts in a range to the folds of their values (by groups), or to
// the only fold; folds whose top level reaches a bound leave the walk, which ends when none is left
function addEventParts(
    folds: (ColumnFolds | null)[],
    groups: ArrayLike<number> | null,
    viewport: PopulationFiltered,
    ranges: readonly Range[],
    accepted: Uint8Array | null,
    ids: Uint32Array | null,
    bound: number
) {
    const { values, cumulative } = viewport.population;
    const { sinkId } = viewport;
    // PERF: Samples are compiled only when signatures don't tell the acceptance of events
    const samples = accepted === null
        ? viewport.samples
        : null;
    let walking = 0;

    for (let i = 0; i < folds.length; i++) {
        if (folds[i] !== null) {
            walking++;
        }
    }

    for (let i = 0; i < ranges.length && walking > 0; i++) {
        const rangeStart = ranges[i].start;
        const rangeEnd = ranges[i].end;
        const rangeFirst = Math.max(0, findCumulativeBoundary(cumulative, rangeStart, true) - 1);
        const rangeLast = findCumulativeBoundary(cumulative, rangeEnd, false);

        for (let j = rangeFirst; j < rangeLast && walking > 0; j++) {
            const group = groups !== null
                ? groups[j]
                : 0;
            const groupFolds = folds[group];

            if (groupFolds !== null && values[j] !== 0 &&
                (accepted !== null ? accepted[ids![j]] === 1 : samples![j] !== sinkId)) {
                let partStart = cumulative[j];
                let partEnd = partStart + values[j];

                // PERF: Comparisons cut parts at range edges faster than Math.max and Math.min here, as measured
                // on walks of tens of millions of events
                if (partStart < rangeStart) {
                    partStart = rangeStart;
                }

                if (partEnd > rangeEnd) {
                    partEnd = rangeEnd;
                }

                groupFolds.addPart(partStart, partEnd);

                if (groupFolds.topMaximum >= bound) {
                    folds[group] = null;
                    walking--;
                }
            }
        }
    }
}

// Cells of events within a range and a column add the accepted records of their signatures to the folds of their
// values and to the total when given; the last event of such a cell can end beyond the column, its part beyond adds to
// the columns it covers. Events of other cells add their parts one by one
function addCellColumns(
    folds: ColumnFolds[],
    signatureGroups: Uint32Array,
    total: ColumnFolds | null,
    signatures: EventSignatures,
    cells: RangeRecords,
    accepted: Uint8Array,
    viewport: PopulationFiltered,
    origin: number
) {
    const { values, cumulative, cumulativeEnd } = viewport.population;
    const { ids } = signatures;
    const { starts } = cells;
    const { duration } = folds[0];
    const ranges = viewport.ranges ?? [{ start: 0, end: cumulativeEnd }];

    for (let i = 0; i < ranges.length; i++) {
        const rangeStart = ranges[i].start;
        const rangeEnd = ranges[i].end;
        const rangeFirst = Math.max(0, findCumulativeBoundary(cumulative, rangeStart, true) - 1);
        const rangeLast = findCumulativeBoundary(cumulative, rangeEnd, false);
        let cell = lowerBound(starts, rangeFirst, true) - 1;

        for (let j = rangeFirst; j < rangeLast; cell++) {
            const cellEnd = starts[cell + 1];
            const last = cellEnd - 1;
            const column = Math.floor((cumulative[j] - origin) / duration);
            const cellWithin = (
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
                const lastEnd = Math.min(cumulative[last] + values[last], rangeEnd);

                const weight = addRecords(folds, signatureGroups, cells, cell, accepted, column);

                total?.add(column, weight);

                if (accepted[ids[last]] === 1 && lastEnd > columnEnd) {
                    const lastFolds = folds[signatureGroups[ids[last]]];

                    lastFolds.add(column, columnEnd - lastEnd);
                    lastFolds.addPart(columnEnd, lastEnd);
                    total?.add(column, columnEnd - lastEnd);
                    total?.addPart(columnEnd, lastEnd);
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

                    folds[signatureGroups[ids[j]]].addPart(partStart, partEnd);
                    total?.addPart(partStart, partEnd);
                }
            }
        }
    }
}

// The accepted records of a cell add to a column of the folds of their values; returns the weight of the records, the
// total adds it once per cell
function addRecords(
    folds: ColumnFolds[],
    signatureGroups: Uint32Array,
    records: RangeRecords,
    cell: number,
    accepted: Uint8Array,
    column: number
) {
    const { recordStarts, signatures, weights } = records;
    const recordsEnd = recordStarts[cell + 1];
    let weight = 0;

    for (let i = recordStarts[cell]; i < recordsEnd; i++) {
        if (accepted[signatures[i]] === 1) {
            folds[signatureGroups[signatures[i]]].add(column, weights[i]);
            weight += weights[i];
        }
    }

    return weight;
}

// The accepted records of a target sum per value first, so the folds of the values walked take a weight per target
// without a check per record; sums of values not walked aren't read. Returns the weight of the records, the total
// adds it once per target
function addTargetRecords(
    walk: AttributeWalk,
    records: RangeRecords,
    target: number,
    accepted: Uint8Array,
    column: number
) {
    const { folds, walked, sums } = walk;
    const signatureGroups = walk.signatureGroups!;
    const { recordStarts, signatures, weights } = records;
    const recordsEnd = recordStarts[target + 1];
    let weight = 0;

    for (let i = recordStarts[target]; i < recordsEnd; i++) {
        const signature = signatures[i];

        if (accepted[signature] === 1) {
            sums[signatureGroups[signature]] += weights[i];
            weight += weights[i];
        }
    }

    for (let i = 0; i < walked.length; i++) {
        const group = walked[i];

        if (sums[group] !== 0) {
            folds[group]!.add(column, sums[group]);
            sums[group] = 0;
        }
    }

    return weight;
}

// A walk of the values of an attribute (by its index) whose rows are shown and have no levels yet: their folds (none
// for other values) and groups, the values of the events and of their signatures (null when signatures don't keep
// them), and the sums of the values of a target
type AttributeWalk = {
    index: number;
    folds: (ColumnFolds | null)[];
    walked: number[];
    values: ArrayLike<number>;
    signatureGroups: Uint32Array | null;
    sums: Float64Array;
};

// The highest columns of a line's events mapped onto another line's axis in order (a nondecreasing mapping): events
// are placed at their targets, so below the level of a target per column (the floor) columns don't change. A walk of
// the events costs the same for any number of levels, so every level from the floor up is taken by one walk of the
// values whose rows are shown and not walked yet, the total with the first walk
class MappedColumns {
    readonly floorLevel: number;
    readonly attributes: ProfileLineAttribute[] = [];
    // Per attribute: values whose rows are shown
    readonly #shown: Uint8Array[] = [];
    readonly #levels = new Map<number, LevelMaxima>();

    constructor(
        readonly line: ProfileLine,
        readonly viewport: PopulationFiltered,
        readonly mapping: Uint32Array,
        readonly axisViewport: PopulationFiltered,
        readonly topLevel: number,
        readonly duration: number,
        readonly origin: number
    ) {
        this.floorLevel = Math.min(0, targetLevel(axisViewport, duration));
    }

    addAttribute(attribute: ProfileLineAttribute, shown: Uint8Array) {
        this.attributes.push(attribute);
        this.#shown.push(shown);
    }

    total(level: number) {
        return this.#level(level).total;
    }

    // A shown value is walked from the floor up, so its highest column is exact
    track(index: number, group: number, level: number) {
        return this.#level(level).tracks[index][group];
    }

    #level(requestedLevel: number) {
        const walks = this.#walks();

        // The total takes the records of the first attribute when no value is to be walked
        if (this.#levels.size === 0) {
            this.#walk(walks.length > 0 ? walks : [this.#walkOf(0)], true);
        } else if (walks.length > 0) {
            this.#walk(walks, false);
        }

        return this.#levels.get(Math.min(Math.max(requestedLevel, this.floorLevel), this.topLevel))!;
    }

    // The walks of the attributes with values to walk
    #walks() {
        const walks: AttributeWalk[] = [];

        for (let i = 0; i < this.attributes.length; i++) {
            const walk = this.#walkOf(i);

            if (walk.walked.length > 0) {
                walks.push(walk);
            }
        }

        return walks;
    }

    // The walk of an attribute (by its index): the folds of the levels from the floor up of its values shown and
    // with no levels taken yet
    #walkOf(index: number): AttributeWalk {
        const { values, dict } = this.attributes[index];
        const shown = this.#shown[index];
        const tracks = this.#levels.get(this.floorLevel)?.tracks[index];
        const baseDuration = this.duration * 2 ** this.floorLevel;
        const folds: (ColumnFolds | null)[] = [];
        const walked: number[] = [];

        for (let i = 0; i < dict.length; i++) {
            if (shown[i] === 1 && Number.isNaN(tracks?.[i] ?? NaN)) {
                folds.push(new ColumnFolds(this.floorLevel, this.topLevel, baseDuration, this.origin));
                walked.push(i);
            } else {
                folds.push(null);
            }
        }

        return {
            index,
            folds,
            walked,
            values,
            signatureGroups: this.line.signatures?.valuesOf(values) ?? null,
            sums: new Float64Array(dict.length)
        };
    }

    // Walks the levels from the floor up of the values of the walks, and of the total when asked
    #walk(walks: AttributeWalk[], withTotal: boolean) {
        const { floorLevel, topLevel } = this;
        const baseDuration = this.duration * 2 ** floorLevel;
        const total = withTotal
            ? new ColumnFolds(floorLevel, topLevel, baseDuration, this.origin)
            : null;

        addMappedColumns(this, walks, total, baseDuration);

        for (let i = 0; i < walks.length; i++) {
            const { index, folds, walked } = walks[i];

            for (let j = 0; j < walked.length; j++) {
                keepFolds(this.#levels, this.attributes, index, walked[j], folds[walked[j]]!.finish(), true);
            }
        }

        if (total !== null) {
            total.finish();

            for (let i = floorLevel; i <= topLevel; i++) {
                takeLevel(this.#levels, i, this.attributes).total = total.maximum(i);
            }
        }
    }
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
    columns: MappedColumns,
    walks: AttributeWalk[],
    total: ColumnFolds | null,
    duration: number
) {
    const { line, viewport, mapping, axisViewport } = columns;
    const { signatures } = line;
    const { sinkId, coverage, boundaryCuts } = viewport;
    const { values } = viewport.population;
    const { destination } = viewport.eventReader();
    const accepted = signatures?.acceptance(viewport) ?? null;
    const keptBySignatures = (walk: AttributeWalk) => walk.signatureGroups !== null;
    const targetColumn = createTargetColumns(axisViewport, duration, columns.origin);
    // Signature records of whole targets sum their events, unless signatures don't tell their acceptance or groups;
    // the total takes their weight with the first attribute
    const records = signatures !== null && accepted !== null && walks.every(keptBySignatures)
        ? signatures.targetRecords(mapping, axisViewport.population.values.length)
        : null;
    const addEvent = (event: number, weight: number) => {
        const column = targetColumn(mapping[event]);

        if (column !== -1 && weight > 0 && destination(event) !== sinkId) {
            total?.add(column, weight);

            for (let i = 0; i < walks.length; i++) {
                walks[i].folds[walks[i].values[event]]?.add(column, weight);
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
                for (let j = 0; j < walks.length; j++) {
                    const weight = addTargetRecords(walks[j], records!, i, accepted!, column);

                    if (j === 0) {
                        total?.add(column, weight);
                    }
                }
            }
        }
    };
    // Whole events [first, end): the targets between the targets of the first and the last event have all of their
    // events among them
    const addSpan = (first: number, end: number) => {
        const firstTarget = mapping[first];
        const lastTarget = mapping[end - 1];

        if (records === null || end - first < 2 || lastTarget - firstTarget < 2) {
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
    columns: OwnColumns | MappedColumns;
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

    // The highest column of a value of an attribute (by its index), or a column at or above a bound when one is:
    // a row scaled to a shared maximum shows its own scale below a share of it only. A row read is shown
    track(attribute: ProfileLineAttribute, group: number, duration: number, columnStart: number, bound = Infinity) {
        this.show(attribute, group);

        const { columns, level } = this.#hierarchyLevel(duration, columnStart);

        return columns.track(this.#attributes.indexOf(attribute), group, level, bound);
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

        const columns = this.mapping === null
            ? new OwnColumns(this.line, this.viewport, topLevel, duration, axisOrigin)
            : new MappedColumns(
                this.line,
                this.viewport,
                this.mapping,
                this.axisViewport,
                topLevel,
                duration,
                axisOrigin
            );

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

// The level of a duration from a column start in a hierarchy, null when its columns aren't columns of it
function hierarchyLevel(hierarchy: Hierarchy, duration: number, columnStart: number) {
    const level = Math.round(Math.log2(duration / hierarchy.duration));
    const levelDuration = hierarchy.duration * 2 ** level;
    const offset = (columnStart - hierarchy.origin) / duration;

    if (Math.abs(levelDuration - duration) > duration * 1e-9 || Math.abs(offset - Math.round(offset)) > 1e-6) {
        return null;
    }

    return level;
}

// The column maxima of a line's viewport population on an axis, kept with the line's population: one per axis
// population it's read on
const lineColumnMaxima = new WeakMap<PopulationFiltered, Map<PopulationFiltered, LineColumnMaxima>>();

// Null when the line's events have no positions on the axis: neither its own axis nor a mapping to the axis line's
// events, or a mapping out of their order
export function getLineColumnMaxima(
    line: ProfileLine,
    viewport: PopulationFiltered,
    axisLine: ProfileLine,
    axisViewport: PopulationFiltered
) {
    const mapping = line !== axisLine
        ? line.mappings[axisLine.type]
        : null;

    if (mapping === undefined) {
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
