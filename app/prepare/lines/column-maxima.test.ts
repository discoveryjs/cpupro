import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Dictionary } from '../dictionary.js';
import { createProfile } from '../profile.mjs';
import { noopWorkHandler } from '../misc/work.js';
import { createLineFixture } from '../../../test/fixtures/profile.js';
import { EventSignatures } from './event-signatures.js';
import { getLineColumnMaxima } from './column-maxima.js';
import type { V8CpuProfile } from '../types.js';
import type { SetAttributeFilter } from '../computations/attribute-filter.js';
import type { ProfileLine, ProfileLineAttribute } from './types.js';
import type { Range } from '../computations/coordinates.js';

type Expected = [total: number, tracks: number[]];

// Allocations of 6, 0, 5, 3, 4, 10 and 2 bytes on their own axis: x over [0, 11) with an empty allocation of y
// inside, then y over [11, 18), x over [18, 28) and y over [28, 30)
async function createRunsLine() {
    const { line, breakdown } = await createLineFixture({
        type: 'memline',
        values: Uint32Array.of(6, 0, 5, 3, 4, 10, 2)
    });
    const attribute = {
        name: 'allocationSpace',
        values: Uint8Array.of(0, 1, 0, 1, 1, 0, 1),
        dict: ['x', 'y']
    } as unknown as ProfileLineAttribute;

    line.attributes = [attribute];

    return {
        line,
        attribute,
        viewport: breakdown.populationViewport
    };
}

// Allocations of 5, 7, 3, 4, 6, 2 and 9 bytes of new (N) and old (O) space, mapped onto CPU samples of 10 ms
// starting at 10 ms: the sample at 10 ms holds N5 and O7, the one at 30 ms N3, N4 and O6, the one at 40 ms O2.
// N9 follows the last sample and has no time
async function createMappedProfile() {
    const data = {
        startTime: 0,
        endTime: 60,
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

function readMaxima(
    maxima: ReturnType<typeof getLineColumnMaxima>,
    attribute: ProfileLineAttribute,
    duration: number,
    start: number
): Expected {
    const tracks: number[] = [];

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
        prepare: (line: ProfileLine) => line.breakdowns[0].populationViewport.filter.set({
            key: 'test',
            domain: 'event',
            size: 7,
            accepts: Uint8Array.of(0, 1, 1, 1, 1, 1, 1)
        }),
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
    const { line, attribute, viewport } = await createRunsLine();

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
        name: 'allocations are read one by one without signatures',
        prepare: (profile: ProfileWithLines) => {
            profile.memline.signatures = null;
        },
        duration: 20,
        start: 10,
        expected: [15, [7, 8]]
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

test('filtered allocations leave gaps between the runs of their own axis', async () => {
    const { memline } = await createMappedProfile() as ProfileWithLines;
    const viewport = memline.breakdowns[0].populationViewport;

    (memline.filters.get('allocationSpace') as SetAttributeFilter).setSelection('exclude', ['old_space']);

    // N5 over [0, 5), N3 and N4 over [12, 19), N9 over [27, 36)
    const maxima = getLineColumnMaxima(memline, viewport, memline, viewport);

    assert.deepEqual(readMaxima(maxima, memline.attributes[0], 10, 0), [7, [7, 0]]);
});

test('a later run of a value adds to the column it is in, not to the column of the previous run', async () => {
    const { line, breakdown } = await createLineFixture({
        type: 'memline',
        values: Uint32Array.of(1, 5, 1, 2, 1)
    });
    const attribute = {
        name: 'allocationSpace',
        values: Uint8Array.of(1, 0, 1, 0, 1),
        dict: ['x', 'y']
    } as unknown as ProfileLineAttribute;
    const viewport = breakdown.populationViewport;

    line.attributes = [attribute];

    // x over [1, 6) and [7, 9), y between and around them at a finer level than x
    const maxima = getLineColumnMaxima(line, viewport, line, viewport);

    assert.deepEqual(readMaxima(maxima, attribute, 4, 0), [4, [3, 1]]);
});

// Levels are read in the order of zooming in and out, every read after a walk at another level
test.each([
    {
        name: 'with a rejected allocation, x over [0, 6), leaving runs of the total shorter than twice a column',
        create: async () => {
            const { line, attribute, viewport } = await createRunsLine();

            viewport.filter.set({
                key: 'test',
                domain: 'event',
                size: 7,
                accepts: Uint8Array.of(0, 1, 1, 1, 1, 1, 1)
            });

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
                attribute: memline.attributes[0]
            };
        },
        start: 10,
        expected: [[13, [7, 7]], [13, [13]]]
    }
] as const)('an attribute read after another on the same grid gets its highest columns, $name', async row => {
    const { maxima, attribute } = await row.create();
    const later = {
        name: 'allocationLifespan',
        values: new Uint8Array(7),
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

// A memline of allocations over 2000 cells (see cellAllocations) with their types and signatures. Cells for windows
// of all but one allocation instead of millions are the 2000 cells of 1024 bytes; column maxima take the records
// built here
async function createCellAllocationsLine(allocations: number[][], dict: string[]) {
    const { values, types } = cellAllocations(allocations);
    const { line, breakdown } = await createLineFixture({
        type: 'memline',
        values
    });
    const viewport = breakdown.populationViewport;
    const { cumulative, cumulativeEnd } = viewport.population;

    line.attributes = [{
        name: 'allocationType',
        values: types,
        dict
    }] as unknown as ProfileLineAttribute[];
    line.signatures = new EventSignatures(line);

    const cells = line.signatures.cellRecords(cumulative, cumulativeEnd, values.length - 1);

    assert.ok(cells !== null && cells.starts.length - 1 === 2000);

    return {
        line,
        attribute: line.attributes[0],
        viewport
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
            size: line.attributes[0].values.length,
            values: line.attributes[0].values,
            accepts: Uint8Array.of(1, 1, 0)
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
        name: 'below the cells, values covering a column of cells cover the finer columns in it',
        duration: 512,
        start: 0,
        expected: [512, [512, 256, 512]]
    },
    {
        name: 'below the cells, y is walked in its cells',
        duration: 256,
        start: 0,
        expected: [256, [256, 128, 256]]
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
        expected: [[300, [300, 0, 0]], [156, [156, 0, 0]]]
    },
    {
        name: 'columns crossing cells below many cells are walked',
        prepare: (line: ProfileLine) => {
            line.viewport.setRange(10240.5, 30000.25);
            line.breakdowns[0].populationViewport.setRanges([{ start: 10240.5, end: 30000.25 }]);
        },
        duration: 8192,
        start: 10240.5,
        expected: [8192, [7542, 650, 5000]]
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

// Allocations of a byte, x and y one after another, so y holds half of any column longer than a byte
async function createAlternatingLine() {
    const { line, breakdown } = await createLineFixture({
        type: 'memline',
        values: new Uint32Array(256).fill(1)
    });
    const attribute = {
        name: 'allocationSpace',
        values: Uint8Array.from({ length: 256 }, (_, index) => index % 2),
        dict: ['x', 'y']
    } as unknown as ProfileLineAttribute;

    line.attributes = [attribute];

    return {
        line,
        attribute,
        viewport: breakdown.populationViewport
    };
}

// Twelve thousand allocations of a byte, y every fourth byte and over [8184, 8200): walks list the events of their
// values a few thousand at a time, and the highest column of y, [8176, 8208), holds events of two of them
test('a walk of a value over many events adds the events of its columns listed apart', async () => {
    const { line, breakdown } = await createLineFixture({
        type: 'memline',
        values: new Uint32Array(12000).fill(1)
    });
    const isY = (index: number) => index % 4 === 0 || (index >= 8184 && index < 8200);
    const attribute = {
        name: 'allocationSpace',
        values: Uint8Array.from({ length: 12000 }, (_, index) => isY(index) ? 1 : 0),
        dict: ['x', 'y']
    } as unknown as ProfileLineAttribute;
    const viewport = breakdown.populationViewport;

    line.attributes = [attribute];

    const maxima = getLineColumnMaxima(line, viewport, line, viewport);

    assert.deepEqual(readMaxima(maxima, attribute, 32, 16), [32, [24, 20]]);
});

// Reads of y in order, for bounds a row shows its own scale below. In cells y holds 350 bytes of a column of 1024, so
// one of 512 holds 175 at least; its highest columns are 256 of 512, 48 of 64 by its contiguous bytes and 32 of 32.
// Without cells y holds 7 bytes of a column of 20 and 4 of 5
test.each([
    {
        name: 'a bound the columns of cells reach at their share of the duration takes no walk',
        create: createCellsLine,
        reads: [[512, 100, 175]]
    },
    {
        name: 'a walk ends at the first column reaching the bound, [10240, 10752) of 206 bytes of y',
        create: createCellsLine,
        reads: [[512, 200, 206]]
    },
    {
        name: 'a walk ended at the bound is no highest column for a later read without one',
        create: createCellsLine,
        reads: [[512, 200, 206], [512, Infinity, 256]]
    },
    {
        name: 'a read at a bound is no highest column for a later read without one',
        create: createCellsLine,
        reads: [[512, 100, 175], [512, Infinity, 256]]
    },
    {
        name: 'a walk takes the levels some levels below the requested one',
        create: createCellsLine,
        reads: [[512, Infinity, 256], [64, Infinity, 48], [32, Infinity, 32]]
    },
    {
        name: 'below the levels of a walk a run at least twice as long as columns covers one of them',
        create: createCellsLine,
        reads: [[512, Infinity, 256], [16, Infinity, 16]]
    },
    {
        name: 'a column of a level below taken before is held by a column of the level above, without cells',
        create: createRunsLine,
        reads: [[5, Infinity, 4], [20, 3, 4]]
    },
    {
        name: 'a share of the duration a value reaches at a level it reaches below the levels of a walk',
        create: createAlternatingLine,
        reads: [[64, Infinity, 32], [1, 0.4, 0.5], [1, Infinity, 1]]
    }
] as const)('a track read for a bound: $name', async row => {
    const { line, attribute, viewport } = await row.create();
    const maxima = getLineColumnMaxima(line, viewport, line, viewport)!;
    const read = (reading: readonly number[]) => maxima.track(attribute, 1, reading[0], 0, reading[1]);
    const expected = (reading: readonly number[]) => reading[2];

    assert.deepEqual(row.reads.map(read), row.reads.map(expected));
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

test('an attribute signatures don\'t keep has the highest columns of its runs on every level', async () => {
    const { line, attribute, viewport } = await createCellsLine();
    const owner = {
        name: 'allocationOwner',
        values: new Uint32Array(attribute.values.length),
        dict: ['one']
    } as unknown as ProfileLineAttribute;
    const maxima = getLineColumnMaxima(line, viewport, line, viewport);

    assert.deepEqual(readMaxima(maxima, owner, 1024, 0), [1024, [1024]]);
    assert.deepEqual(readMaxima(maxima, owner, 512, 0), [512, [512]]);

    // Values without cells are walked over the whole ranges
    const allocator = {
        name: 'allocationAllocator',
        values: Uint32Array.from(attribute.values, value => value === 0 ? 0 : value + 1),
        dict: ['x', 'none', 'y', 'z']
    } as unknown as ProfileLineAttribute;

    assert.deepEqual(readMaxima(maxima, allocator, 256, 0), [256, [256, 0, 128, 256]]);
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
});
