import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { Dictionary } from '../dictionary.js';
import { createProfile } from '../profile.mjs';
import { noopWorkHandler } from '../misc/work.js';
import { createLineFixture } from '../../../test/fixtures/profile.js';
import { EventSignatures, keyLineBySignatures } from './event-signatures.js';
import { getLineColumnMaxima } from './column-maxima.js';
import type { V8CpuProfile } from '../types.js';
import type { SetAttributeFilter } from '../computations/attribute-filter.js';
import type { ProfileLine, ProfileLineAttribute } from './types.js';
import type { Range } from '../computations/coordinates.js';
import { dictEntries } from '../../../test/fixtures/lines.js';

type Expected = [total: number, tracks: number[]];

// A memline of allocations of the values with an attribute, keyed by the signatures of its allocations as lines are;
// a filter of allocations by their indices rejects some, registered before signatures as filters of lines are
async function createKeyedLine(values: Uint32Array, attribute: ProfileLineAttribute, rejected: number[] = []) {
    const { line, breakdown } = await createLineFixture({
        type: 'memline',
        values,
        attributes: [attribute]
    });

    if (rejected.length > 0) {
        breakdown.populationViewport.filter.set({
            key: 'test',
            domain: 'event',
            size: values.length,
            values: Uint32Array.from(values, (_, index) => index),
            accepts: Uint8Array.from(values, (_, index) => rejected.includes(index) ? 0 : 1)
        });
    }

    line.signatures = new EventSignatures(line);
    keyLineBySignatures(line);

    return {
        line,
        viewport: breakdown.populationViewport
    };
}

// Allocations of 6, 0, 5, 3, 4, 10 and 2 bytes on their own axis: x over [0, 11) with an empty allocation of y
// inside, then y over [11, 18), x over [18, 28) and y over [28, 30)
async function createRunsLine(rejected: number[] = []) {
    const attribute = {
        name: 'allocationSpace',
        keys: Uint8Array.of(0, 1, 0, 1, 1, 0, 1),
        entries: dictEntries(['x', 'y']),
        dict: ['x', 'y']
    } as unknown as ProfileLineAttribute;

    return {
        ...await createKeyedLine(Uint32Array.of(6, 0, 5, 3, 4, 10, 2), attribute, rejected),
        attribute
    };
}

// Allocations of 5, 7, 3, 4, 6, 2 and 9 bytes of new (N) and old (O) space, mapped onto CPU samples of 10 ms
// starting at 10 ms: the sample at 10 ms holds N5 and O7, the one at 30 ms N3, N4 and O6, the one at 40 ms O2.
// N9 follows the last sample and has no time
async function createMappedProfile(startTime = 0) {
    const data = {
        startTime,
        endTime: startTime + 60,
        nodes: [
            {
                id: 1,
                callFrame: { scriptId: 0, url: '', functionName: '(root)', lineNumber: -1, columnNumber: -1 },
                children: [2, 3]
            },
            { id: 2, callFrame: { scriptId: 0, url: '', functionName: 'first', lineNumber: 0, columnNumber: 0 } },
            { id: 3, callFrame: { scriptId: 0, url: '', functionName: 'second', lineNumber: 0, columnNumber: 10 } }
        ],
        samples: [2, 3, 2, 3, 2],
        timeDeltas: [10, 10, 10, 10, 10],
        _cpuproAllocationMapping: [2, 2, 5, 6, 6],
        _cpuproAllocationIds: [1, 2, 3, 4, 5, 6, 7],
        _cpuproAllocationSizes: [5, 7, 3, 4, 6, 2, 9],
        _cpuproAllocationSpaces: [0, 1, 0, 0, 1, 1, 0],
        _cpuproAllocationSpaceNames: { 0: 'new_space', 1: 'old_space' }
    } as V8CpuProfile;

    return createProfile(data, { dictionary: new Dictionary(), work: noopWorkHandler });
}

// Rows of all values are shown before they're read, as views show the rows of a section
function readMaxima(
    maxima: ReturnType<typeof getLineColumnMaxima>,
    attribute: ProfileLineAttribute,
    duration: number,
    start: number
): Expected {
    const tracks: number[] = [];

    for (let i = 0; i < attribute.dict.length; i++) {
        maxima!.show(attribute, i);
    }

    for (let i = 0; i < attribute.dict.length; i++) {
        tracks.push(maxima!.track(attribute, i, duration, start));
    }

    return [maxima!.total(duration, start), tracks];
}

test.each([
    {
        name: 'columns sum the parts of the runs of a value in them',
        duration: 10,
        start: 0,
        expected: [10, [10, 7]]
    },
    {
        name: 'columns of a doubled duration hold two columns of the duration',
        duration: 20,
        start: 0,
        expected: [20, [13, 7]]
    },
    {
        name: 'a column over the viewport holds all of it',
        duration: 40,
        start: 0,
        expected: [30, [21, 9]]
    },
    {
        name: 'columns from another start have maximums of their own',
        duration: 10,
        start: 5,
        expected: [10, [7, 4]]
    },
    {
        name: 'a run gives the duration where it covers a column, y of 7 bytes covers none of 5',
        duration: 5,
        start: 0,
        expected: [5, [5, 4]]
    },
    {
        name: 'runs at least twice as long as columns give their duration',
        duration: 0.5,
        start: 0,
        expected: [0.5, [0.5, 0.5]]
    },
    {
        name: 'a rejected allocation leaves a gap, x over [0, 6)',
        rejected: [0],
        duration: 10,
        start: 0,
        expected: [10, [8, 7]]
    },
    {
        name: 'viewport ranges [3, 16) and [20, 29) cut allocations',
        prepare: (line: ProfileLine) => line.breakdowns[0].populationViewport.setRanges([
            { start: 3, end: 16 },
            { start: 20, end: 29 }
        ]),
        duration: 10,
        start: 0,
        expected: [9, [8, 5]]
    }
] as const)('highest columns of allocations on their own axis: $name', async row => {
    const rejected = 'rejected' in row
        ? [...row.rejected]
        : [];
    const { line, attribute, viewport } = await createRunsLine(rejected);

    if ('prepare' in row) {
        row.prepare(line);
    }

    const maxima = getLineColumnMaxima(line, viewport, line, viewport);

    assert.deepEqual(readMaxima(maxima, attribute, row.duration, row.start), row.expected);
});

test.each([
    {
        name: 'columns hold the allocations of their samples',
        duration: 10,
        start: 10,
        expected: [13, [7, 7]]
    },
    {
        name: 'columns of a doubled duration hold two columns of the duration',
        duration: 20,
        start: 10,
        expected: [15, [7, 8]]
    },
    {
        name: 'columns from another start have maximums of their own',
        duration: 20,
        start: 0,
        expected: [13, [7, 7]]
    },
    {
        name: 'columns shorter than samples hold a sample at most',
        duration: 2.5,
        start: 10,
        expected: [13, [7, 7]]
    },
    {
        name: 'memline ranges [8, 21) count the covered parts of cut allocations, O4 and O2',
        prepare: (profile: ProfileWithLines) => profile.memline.breakdowns[0].populationViewport.setRanges([
            { start: 8, end: 21 }
        ]),
        duration: 10,
        start: 10,
        expected: [9, [7, 4]]
    },
    {
        name: 'samples out of the timeline viewport [20, 35) are left out, at 10 and 40 ms',
        prepare: (profile: ProfileWithLines) => profile.timeline.viewport.selection.setRange(20, 35),
        duration: 20,
        start: 10,
        expected: [13, [7, 6]]
    },
    {
        name: 'filtered allocations are left out',
        prepare: (profile: ProfileWithLines) => (profile.memline.filters.get('allocationSpace') as SetAttributeFilter)
            .setSelection('exclude', ['old_space']),
        duration: 20,
        start: 10,
        expected: [7, [7, 0]]
    }
] as const)('highest columns of allocations on the timeline: $name', async row => {
    const profile = await createMappedProfile() as ProfileWithLines;
    const { memline, timeline } = profile;

    if ('prepare' in row) {
        row.prepare(profile);
    }

    const maxima = getLineColumnMaxima(
        memline,
        memline.breakdowns[0].populationViewport,
        timeline,
        timeline.breakdowns[0].populationViewport
    );

    assert.deepEqual(readMaxima(maxima, memline.attributes[0], row.duration, row.start), row.expected);
});

test('columns from a start off their origin by the rounding of coordinates are read from one hierarchy', async () => {
    // Timestamps of a trace: a unit of their last place is 2^-15
    const startTime = 270351962000;
    const { memline, timeline } = await createMappedProfile(startTime) as ProfileWithLines;
    const maxima = getLineColumnMaxima(
        memline,
        memline.breakdowns[0].populationViewport,
        timeline,
        timeline.breakdowns[0].populationViewport
    );
    const createHierarchy = vi.spyOn(timeline.range.frame, 'rebaseValue');
    // The origin of the columns, a multiple of the top column before the start, rounds to the timestamps
    const duration = 0.3;
    const start = startTime + 12.5;

    assert.deepEqual(readMaxima(maxima, memline.attributes[0], duration, start), [13, [7, 7]]);
    assert.deepEqual(readMaxima(maxima, memline.attributes[0], duration / 4, start), [13, [7, 7]]);
    assert.equal(createHierarchy.mock.calls.length, 1);
});

test('values of an attribute take the rows of the entries of their codes on the timeline', async () => {
    const { memline, timeline } = await createMappedProfile() as ProfileWithLines;
    const read = () => readMaxima(
        getLineColumnMaxima(
            memline,
            memline.breakdowns[0].populationViewport,
            timeline,
            timeline.breakdowns[0].populationViewport
        ),
        memline.attributes[0],
        20,
        10
    );

    const expected = read();
    const space = memline.attributes[0];

    // Two codes per entry, alternating between allocations, keyed by the signatures of allocations again
    memline.attributes = [{
        ...space,
        keys: Uint8Array.from(space.keys, (signature, index) => space.entries[signature] * 2 + index % 2),
        entries: Uint8Array.from({ length: space.dict.length * 2 }, (_, code) => code >> 1)
    }];
    memline.signatures = new EventSignatures(memline);
    keyLineBySignatures(memline);

    assert.deepEqual(read(), expected);
});

test('filtered allocations leave gaps between the runs of their own axis', async () => {
    const { memline } = await createMappedProfile() as ProfileWithLines;
    const viewport = memline.breakdowns[0].populationViewport;

    (memline.filters.get('allocationSpace') as SetAttributeFilter).setSelection('exclude', ['old_space']);

    // N5 over [0, 5), N3 and N4 over [12, 19), N9 over [27, 36)
    const maxima = getLineColumnMaxima(memline, viewport, memline, viewport);

    assert.deepEqual(readMaxima(maxima, memline.attributes[0], 10, 0), [7, [7, 0]]);
});

test('a later run of a value adds to the column it is in, not to the column of the previous run', async () => {
    const attribute = {
        name: 'allocationSpace',
        keys: Uint8Array.of(1, 0, 1, 0, 1),
        entries: dictEntries(['x', 'y']),
        dict: ['x', 'y']
    } as unknown as ProfileLineAttribute;
    const { line, viewport } = await createKeyedLine(Uint32Array.of(1, 5, 1, 2, 1), attribute);

    // x over [1, 6) and [7, 9), y between and around them at a finer level than x
    const maxima = getLineColumnMaxima(line, viewport, line, viewport);

    assert.deepEqual(readMaxima(maxima, attribute, 4, 0), [4, [3, 1]]);
});

// Levels are read in the order of zooming in and out, a finer one after a coarser one
test.each([
    {
        name: 'with a rejected allocation, x over [0, 6), leaving runs of the total shorter than twice a column',
        create: async () => {
            const { line, attribute, viewport } = await createRunsLine([0]);

            return {
                maxima: getLineColumnMaxima(line, viewport, line, viewport),
                attribute
            };
        },
        start: 0,
        levels: [
            [10, [10, [8, 7]]],
            [20, [14, [8, 7]]]
        ]
    },
    {
        name: 'on their own axis',
        create: async () => {
            const { line, attribute, viewport } = await createRunsLine();

            return {
                maxima: getLineColumnMaxima(line, viewport, line, viewport),
                attribute
            };
        },
        start: 0,
        levels: [
            [10, [10, [10, 7]]],
            [0.625, [0.625, [0.625, 0.625]]],
            [5, [5, [5, 4]]],
            [20, [20, [13, 7]]]
        ]
    },
    {
        name: 'viewport ranges [3, 15) and [16, 29) cut y over [14, 18) in two parts',
        create: async () => {
            const { line, attribute, viewport } = await createRunsLine();

            viewport.setRanges([
                { start: 3, end: 15 },
                { start: 16, end: 29 }
            ]);

            return {
                maxima: getLineColumnMaxima(line, viewport, line, viewport),
                attribute
            };
        },
        start: 0,
        levels: [
            [5, [5, [5, 4]]],
            [10, [9, [8, 6]]]
        ]
    },
    {
        name: 'on the timeline',
        create: async () => {
            const { memline, timeline } = await createMappedProfile() as ProfileWithLines;

            return {
                maxima: getLineColumnMaxima(
                    memline,
                    memline.breakdowns[0].populationViewport,
                    timeline,
                    timeline.breakdowns[0].populationViewport
                ),
                attribute: memline.attributes[0]
            };
        },
        start: 10,
        levels: [
            [10, [13, [7, 7]]],
            [0.625, [13, [7, 7]]],
            [40, [27, [12, 15]]],
            [20, [15, [7, 8]]],
            [160, [27, [12, 15]]]
        ]
    }
] as const)('levels of one grid give their highest columns in any order, $name', async row => {
    const { maxima, attribute } = await row.create();

    for (let i = 0; i < row.levels.length; i++) {
        const [duration, expected] = row.levels[i];

        assert.deepEqual(readMaxima(maxima, attribute, duration, row.start), expected, `columns of ${duration}`);
    }
});

// An attribute of one value over the seven allocations of either line has the total in its track
test.each([
    {
        name: 'on their own axis',
        create: async () => {
            const { line, attribute, viewport } = await createRunsLine();

            return {
                maxima: getLineColumnMaxima(line, viewport, line, viewport),
                line,
                attribute
            };
        },
        start: 0,
        expected: [[10, [10, 7]], [10, [10]]]
    },
    {
        name: 'on the timeline',
        create: async () => {
            const { memline, timeline } = await createMappedProfile() as ProfileWithLines;

            return {
                maxima: getLineColumnMaxima(
                    memline,
                    memline.breakdowns[0].populationViewport,
                    timeline,
                    timeline.breakdowns[0].populationViewport
                ),
                line: memline,
                attribute: memline.attributes[0]
            };
        },
        start: 10,
        expected: [[13, [7, 7]], [13, [13]]]
    }
] as const)('an attribute read after another on the same grid gets its highest columns, $name', async row => {
    const { maxima, line, attribute } = await row.create();
    // One value, keyed by the signatures of allocations when the line has them
    const later = {
        name: 'allocationLifespan',
        keys: line.signatures?.ids ?? new Uint8Array(7),
        entries: new Uint32Array(line.signatures?.count ?? 1),
        dict: ['all']
    } as unknown as ProfileLineAttribute;

    assert.deepEqual(readMaxima(maxima, attribute, 10, row.start), row.expected[0]);
    assert.deepEqual(readMaxima(maxima, later, 10, row.start), row.expected[1]);
    assert.deepEqual(readMaxima(maxima, attribute, 10, row.start), row.expected[0]);
});

// Parts [from, to) of the cells of 1024 bytes from a first cell to an end cell
function cellParts(first: number, end: number, from: number, to: number) {
    const parts: Range[] = [];

    for (let i = first; i < end; i++) {
        parts.push({ start: i * 1024 + from, end: i * 1024 + to });
    }

    return parts;
}

// Allocations over 2000 cells of 1024 bytes: the allocations given as [start byte, size, type] in their order, and
// allocations of x over the bytes between them, one up to the next allocation given or the end of a cell
function cellAllocations(allocations: number[][]) {
    const values: number[] = [];
    const types: number[] = [];
    let next = 0;

    for (let byte = 0; byte < 2000 * 1024;) {
        if (next < allocations.length && allocations[next][0] === byte) {
            const [, size, type] = allocations[next++];

            values.push(size);
            types.push(type);
            byte += size;
        } else {
            const cellEnd = (Math.floor(byte / 1024) + 1) * 1024;
            const end = next < allocations.length
                ? Math.min(cellEnd, allocations[next][0])
                : cellEnd;

            values.push(end - byte);
            types.push(0);
            byte = end;
        }
    }

    return {
        values: Uint32Array.from(values),
        types: Uint8Array.from(types)
    };
}

// A memline of allocations over 2000 cells (see cellAllocations) with their types, keyed by their signatures, and
// the types of the allocations. Cells for windows of all but one allocation instead of millions are the 2000 cells
// of 1024 bytes; column maxima take the records built here
async function createCellAllocationsLine(allocations: number[][], dict: string[]) {
    const { values, types } = cellAllocations(allocations);
    const { line, viewport } = await createKeyedLine(values, {
        name: 'allocationType',
        keys: types,
        entries: dictEntries(dict),
        dict
    } as unknown as ProfileLineAttribute);
    const { cumulative, cumulativeEnd } = viewport.population;
    const cells = line.signatures!.cellRecords(cumulative, cumulativeEnd, values.length - 1);

    assert.ok(cells !== null && cells.starts.length - 1 === 2000);

    return {
        line,
        attribute: line.attributes[0],
        viewport,
        types
    };
}

// A line of x everywhere, y on every other byte of [10340, 11040), [11264, 11864) and [26600, 26800) and over
// [27600, 27648), the end of a cell before cells of x only, and z of 5000 bytes over [20980, 25980)
async function createCellsLine() {
    const yBytes = (start: number, end: number, step: number) => {
        const allocations: number[][] = [];

        for (let i = start; i < end; i += step) {
            allocations.push([i, 1, 1]);
        }

        return allocations;
    };

    return createCellAllocationsLine([
        ...yBytes(10340, 11040, 2),
        ...yBytes(11264, 11864, 2),
        [20980, 5000, 2],
        ...yBytes(26600, 26800, 2),
        ...yBytes(27600, 27648, 1)
    ], ['x', 'y', 'z']);
}

test.each([
    {
        name: 'columns of cells take their records, z ending beyond its cell covers columns',
        duration: 1024,
        start: 0,
        expected: [1024, [1024, 350, 1024]]
    },
    {
        name: 'a rejected z, the last allocation of its cell, leaves no part beyond the column of the cell',
        prepare: (line: ProfileLine) => line.breakdowns[0].populationViewport.filter.set({
            key: 'test',
            domain: 'event',
            size: line.attributes[0].keys.length,
            values: line.attributes[0].keys,
            accepts: Uint8Array.from(line.attributes[0].entries, entry => entry === 2 ? 0 : 1)
        }),
        duration: 1024,
        start: 0,
        expected: [1024, [1024, 350, 0]]
    },
    {
        name: 'columns of two cells, z covers one of them whole',
        duration: 2048,
        start: 0,
        expected: [2048, [2048, 650, 2048]]
    },
    {
        name: 'below the cells a column holds no more than its duration and the highest column of the cells',
        durations: [512, 256],
        start: 0,
        expected: [[512, [512, 350, 512]], [256, [256, 256, 256]]]
    },
    {
        name: 'a viewport range [10240.5, 30000.25) cuts the first allocation of a cell, its column edge crosses y',
        prepare: (line: ProfileLine) => {
            line.viewport.setRange(10240.5, 30000.25);
            line.breakdowns[0].populationViewport.setRanges([{ start: 10240.5, end: 30000.25 }]);
        },
        duration: 16384,
        start: 10240.5,
        expected: [16384, [10721.5, 662.5, 5000]]
    },
    {
        name: 'a column from before the range holds the cut first allocation of a cell',
        prepare: (line: ProfileLine) => {
            line.viewport.setRange(10240.5, 30000.25);
            line.breakdowns[0].populationViewport.setRanges([{ start: 10240.5, end: 30000.25 }]);
        },
        duration: 16384,
        start: 2048.5,
        expected: [11567.75, [7542, 650, 5000]]
    },
    {
        name: 'a viewport range ending in the last allocation of a cell leaves its part beyond the range out',
        prepare: (line: ProfileLine) => {
            line.viewport.setRange(10240.5, 30719.5);
            line.breakdowns[0].populationViewport.setRanges([{ start: 10240.5, end: 30719.5 }]);
        },
        duration: 16384,
        start: 2048.5,
        expected: [12287, [7542, 650, 5000]]
    },
    {
        name: 'ranges of 300 bytes in every cell after the values other than x leave no column of cells covered',
        prepare: (line: ProfileLine) => {
            const ranges = cellParts(30, 1999, 100, 400);

            line.viewport.setRange(ranges[0].start, ranges[ranges.length - 1].end);
            line.breakdowns[0].populationViewport.setRanges(ranges);
        },
        durations: [1024, 256],
        start: 30720,
        expected: [[300, [300, 0, 0]], [256, [256, 0, 0]]]
    },
    {
        name: 'columns crossing cells below many cells take the bound of the columns of many cells',
        prepare: (line: ProfileLine) => {
            line.viewport.setRange(10240.5, 30000.25);
            line.breakdowns[0].populationViewport.setRanges([{ start: 10240.5, end: 30000.25 }]);
        },
        duration: 8192,
        start: 10240.5,
        expected: [8192, [8192, 662.5, 5000]]
    }
] as const)('highest columns of allocations on their own axis by cells: $name', async row => {
    const { line, attribute, viewport } = await createCellsLine();

    if ('prepare' in row) {
        row.prepare(line);
    }

    const maxima = getLineColumnMaxima(line, viewport, line, viewport);

    if ('durations' in row) {
        const read = (duration: number) => readMaxima(maxima, attribute, duration, row.start);

        assert.deepEqual(row.durations.map(read), row.expected);
    } else {
        assert.deepEqual(readMaxima(maxima, attribute, row.duration, row.start), row.expected);
    }
});

// Codes of values of an attribute other than its dictionary indices (as GC epochs of lifespans) reach the rows of their
// entries in columns of cells and below them
test('values of an attribute take the rows of the entries of their codes', async () => {
    const { line, attribute, viewport, types } = await createCellsLine();
    const read = (duration: number, start: number) => readMaxima(
        getLineColumnMaxima(line, viewport, line, viewport),
        line.attributes[0],
        duration,
        start
    );
    // Columns of cells and below them over the line, then over a range cutting the first allocation of a cell
    const reads = () => {
        const own = [read(1024, 0), read(256, 0)];

        line.viewport.setRange(10240.5, 30000.25);
        viewport.setRanges([{ start: 10240.5, end: 30000.25 }]);

        const ranged = [read(16384, 10240.5), read(8192, 10240.5)];

        line.viewport.resetRange();
        viewport.setRanges(null);

        return [...own, ...ranged];
    };
    const expected = reads();

    // Two codes per entry, alternating between events
    line.attributes = [{
        ...attribute,
        keys: Uint8Array.from(types, (type, index) => type * 2 + index % 2),
        entries: Uint8Array.from({ length: attribute.dict.length * 2 }, (_, code) => code >> 1)
    }];
    line.signatures = new EventSignatures(line);
    keyLineBySignatures(line);
    line.signatures.cellRecords(
        viewport.population.cumulative,
        viewport.population.cumulativeEnd,
        line.values.length - 1
    );

    assert.deepEqual(reads(), expected);
});

test.each([
    {
        name: 'on their own axis, by the records of cells',
        create: async () => {
            const { line, attribute, viewport } = await createCellsLine();

            return {
                maxima: getLineColumnMaxima(line, viewport, line, viewport),
                attribute
            };
        },
        duration: 2048,
        start: 0,
        expected: [2048, [2048, 650, 2048]]
    },
    {
        name: 'on the timeline, by the records of samples',
        create: async () => {
            const { memline, timeline } = await createMappedProfile() as ProfileWithLines;

            return {
                maxima: getLineColumnMaxima(
                    memline,
                    memline.breakdowns[0].populationViewport,
                    timeline,
                    timeline.breakdowns[0].populationViewport
                ),
                attribute: memline.attributes[0]
            };
        },
        duration: 10,
        start: 10,
        expected: [13, [7, 7]]
    }
] as const)('attributes shown together take the records of their values in one pass, $name', async row => {
    const { maxima, attribute } = await row.create();
    // The keys of the attribute with its entries in reverse order
    const reversed = {
        name: 'allocationLifespan',
        keys: attribute.keys,
        entries: Uint32Array.from(attribute.dict, (_, code) => attribute.dict.length - 1 - code),
        dict: [...attribute.dict].reverse()
    } as unknown as ProfileLineAttribute;

    for (let i = 0; i < attribute.dict.length; i++) {
        maxima!.show(attribute, i);
        maxima!.show(reversed, i);
    }

    const [total, tracks] = readMaxima(maxima, attribute, row.duration, row.start);

    assert.deepEqual([total, tracks], row.expected);
    assert.deepEqual(readMaxima(maxima, reversed, row.duration, row.start), [total, [...tracks].reverse()]);
});

// One allocation of y over [2148, 16484) among x: it covers cells 3 to 15 whole
test('an allocation over many cells covers columns of every level within it', async () => {
    const { line, attribute, viewport } = await createCellAllocationsLine([[2148, 14336, 1]], ['x', 'y']);
    const maxima = getLineColumnMaxima(line, viewport, line, viewport);
    const read = (duration: number) => readMaxima(maxima, attribute, duration, 0);

    assert.deepEqual([1024, 2048, 4096, 8192, 16384].map(read), [
        [1024, [1024, 1024]],
        [2048, [2048, 2048]],
        [4096, [4096, 4096]],
        [8192, [8192, 8192]],
        [16384, [16384, 14236]]
    ]);

    // A viewport range of y alone leaves its columns the only ones covered whole for the total
    line.viewport.setRange(2148, 16484);
    viewport.setRanges([{ start: 2148, end: 16484 }]);

    assert.deepEqual([1024, 2048, 4096, 8192, 16384].map(read), [
        [1024, [0, 1024]],
        [2048, [0, 2048]],
        [4096, [0, 4096]],
        [8192, [0, 8192]],
        [14236, [0, 14236]]
    ]);
});

type ProfileWithLines = {
    memline: ProfileLine;
    timeline: ProfileLine;
};

test('a line gives no maximums on an axis it has no positions on', async () => {
    const { timeline, memline } = await createMappedProfile() as ProfileWithLines;
    const { line: unmapped } = await createLineFixture({ type: 'memline' });
    const columnMaxima = (line: ProfileLine, axisLine: ProfileLine) => getLineColumnMaxima(
        line,
        line.breakdowns[0].populationViewport,
        axisLine,
        axisLine.breakdowns[0].populationViewport
    );

    // Allocations without a mapping to CPU samples, and samples mapped onto allocations out of their order
    assert.equal(columnMaxima(unmapped, timeline), null);
    assert.equal(columnMaxima(timeline, memline), null);
    assert.notEqual(columnMaxima(memline, timeline), null);

    // Column maxima walk the events of a line by their signatures
    memline.signatures = null;
    assert.equal(columnMaxima(memline, timeline), null);
});
