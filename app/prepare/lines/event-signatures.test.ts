import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SourceMapGenerator } from 'source-map-js';
import { Dictionary } from '../dictionary.js';
import { createProfile } from '../profile.mjs';
import { noopWorkHandler } from '../misc/work.js';
import { methods } from '../../jora/bin.js';
import { lineWindow } from '../../jora/viewport.js';
import { BinRecords, EventSignatures } from './event-signatures.js';
import type { V8CpuProfile } from '../types.js';
import type { SetAttributeFilter } from '../computations/attribute-filter.js';
import type { ProfileLine } from './types.js';

// Deterministic pseudo-random sequence
function sequence(seed: number) {
    return (max: number) => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;

        return (seed >>> 8) % max;
    };
}

// Source maps add source-mapped breakdowns with their own category distributions
function createSourceMap() {
    const generator = new SourceMapGenerator({ file: 'a.js' });

    for (const column of [0, 10, 20]) {
        generator.addMapping({
            generated: { line: 1, column },
            original: { line: column / 10 + 1, column: 0 },
            source: 'original.js'
        });
    }

    return JSON.parse(generator.toString());
}

// Allocations spread over CPU samples; some samples have no allocations, one has many
async function createSignaturesProfile({ mapped = true } = {}) {
    const random = sequence(7);
    const sampleCount = 400;
    const allocationCount = 5000;
    const allocationIds = Array.from({ length: allocationCount }, (_, index) => index + 1);
    const mapping: number[] = [];
    let lastId = 0;

    for (let sample = 0; sample < sampleCount; sample++) {
        const allocations = sample === 170 ? 600 : random(3) === 0 ? 0 : 1 + random(20);

        lastId = Math.min(allocationCount, lastId + allocations);
        mapping.push(lastId);
    }

    const data: V8CpuProfile = {
        startTime: 0,
        endTime: 10 * sampleCount + 10,
        nodes: [
            { id: 1, callFrame: { scriptId: 0, url: '', functionName: '(root)', lineNumber: -1, columnNumber: -1 }, children: [2, 3, 4] },
            { id: 2, callFrame: { scriptId: 1, url: '/a.js', functionName: 'first', lineNumber: 0, columnNumber: 0 } },
            { id: 3, callFrame: { scriptId: 1, url: '/a.js', functionName: 'second', lineNumber: 0, columnNumber: 20 } },
            { id: 4, callFrame: { scriptId: 0, url: '', functionName: '(garbage collector)', lineNumber: -1, columnNumber: -1 } }
        ],
        samples: Array.from({ length: sampleCount }, () => 2 + random(3)),
        timeDeltas: Array.from({ length: sampleCount }, () => 5 + random(10)),
        _samplePositions: Array.from({ length: sampleCount }, () => 10 * random(3)),
        _scripts: [{ id: 1, url: '/a.js', source: '', sourceMap: createSourceMap() }],
        _cpuproAllocationMapping: mapped ? mapping : undefined,
        _cpuproAllocationIds: allocationIds,
        _cpuproAllocationSizes: Array.from({ length: allocationCount }, () => random(5) === 0 ? 0 : 1 + random(300)),
        // GC code: epoch << 2 | 1 (minor) or 2 (major), 0 for alive allocations
        _cpuproAllocationGc: Array.from({ length: allocationCount }, () => random(2) === 0 ? 0 : (1 + random(3)) << 2 | (1 + random(2))),
        _cpuproAllocationSpaces: Array.from({ length: allocationCount }, () => random(3)),
        _cpuproAllocationSpaceNames: { 0: 'new_space', 1: 'old_space', 2: 'code_space' },
        _cpuproAllocationScriptIds: Array.from({ length: allocationCount }, () => random(2)),
        _cpuproAllocationLocations: Array.from({ length: allocationCount }, () => 10 * random(3)),
        _cpuproAllocationContextInfo: Array.from({ length: allocationCount }, () => random(3)),
        _cpuproAllocationVmStateNames: { 1: 'gc', 2: 'parser' }
    } as V8CpuProfile;
    const dictionary = new Dictionary();

    return createProfile(data, { dictionary, work: noopWorkHandler });
}

test('signatures group allocations by equal attribute, category and filter values', async () => {
    const { memline, timeline } = await createSignaturesProfile();
    const signatures = memline!.signatures!;
    const columns = [
        ...memline!.attributes.map(attribute => (event: number) => attribute.values[event]),
        ...memline!.breakdowns.map(({ categories, population }) => (event: number) => categories!.sampleToNode[population.samples[event]])
    ];

    assert.deepEqual(memline!.breakdowns.map(breakdown => breakdown.kind), ['call-stack', 'location', 'call-stack-sm', 'location-sm']);
    assert.ok(signatures.count > 1 && signatures.count < memline!.values.length);
    assert.ok(timeline!.signatures!.count > 1);

    for (let event = 0; event < memline!.values.length; event++) {
        const signature = signatures.ids[event];
        const first = signatures.events[signature];

        assert.ok(first <= event);
        for (const column of columns) {
            assert.equal(column(event), column(first));
        }
    }

    for (const attribute of memline!.attributes) {
        const values = signatures.valuesOf(attribute.values)!;

        for (let signature = 0; signature < signatures.count; signature++) {
            assert.equal(values[signature], attribute.values[signatures.events[signature]]);
        }
    }

    for (const { categories, population } of memline!.breakdowns) {
        const nodes = signatures.valuesOf(categories!.sampleToNode)!;

        for (let signature = 0; signature < signatures.count; signature++) {
            assert.equal(nodes[signature], categories!.sampleToNode[population.samples[signatures.events[signature]]]);
        }
    }
});

test('whole-line signature totals give attribute rows without an event pass, regardless of viewport and filters', async () => {
    const profile = await createSignaturesProfile();
    const memline = profile.memline!;
    const { signatures, breakdowns } = memline;
    const context = { scopeProfile: profile, scopeLine: profile.timeline };
    const totals = signatures!.totals();

    assert.equal(signatures!.totals(), totals);
    assert.equal(totals.reduce((sum, value) => sum + value, 0), memline.axisTotal);

    memline.viewport.selection.setRange(100, 2000);
    profile.timeline!.viewport.selection.setRange(500, 1500);
    (memline.filters.get('allocationSpace') as SetAttributeFilter).setSelection('include', ['old_space']);

    for (const attribute of memline.attributes) {
        const rows = methods.allocationAttributeRows.call({ context }, attribute.name);
        const { samplesTotal } = breakdowns[0].population.aggregateBy(attribute.values, attribute.dict.length);

        assert.deepEqual(rows.map(row => row.value), Array.from(samplesTotal));
        assert.deepEqual(rows.map(row => [row.index, row.entry]), attribute.dict.map((entry, index) => [index, entry]));
    }
});

test('filter classes group events with equal values of every registered event filter', async () => {
    const { memline } = await createSignaturesProfile();
    const { ids, events, values } = memline!.signatures!.filterClasses;
    const filterValues = [...new Set(memline!.breakdowns.flatMap(({ populationViewport }) => populationViewport.filter.filters
        .filter(filter => filter.domain === 'event' && filter.values !== undefined)
        .map(filter => filter.values!)))];

    assert.ok(filterValues.length >= 2);
    assert.deepEqual(new Set(filterValues), values);
    assert.ok(events.length > 1);

    for (let event = 0; event < ids.length; event++) {
        const first = events[ids[event]];

        assert.ok(first <= event);
        for (const column of filterValues) {
            assert.equal(column[event], column[first]);
        }
    }

    for (let eventClass = 1; eventClass < events.length; eventClass++) {
        assert.ok(filterValues.some(column => column[events[eventClass]] !== column[events[0]]));
    }
});

// A line of events with the given attribute values and no breakdowns
function createAttributesLine(...columns: ArrayLike<number>[]) {
    const names = ['allocationType', 'allocationSpace'];

    return {
        values: new Uint32Array(columns[0].length),
        attributes: columns.map((values, index) => ({
            name: names[index],
            values: Uint32Array.from(values),
            // Values index the dictionary
            dict: new Array(Array.from(values).reduce((max, value) => Math.max(max, value), -1) + 1)
        })),
        breakdowns: []
    } as unknown as ProfileLine;
}

// Ids are numbered in the order of the first events of their combinations, whatever the order of combined columns
test.each([
    {
        name: 'the first column',
        first: [0, 0, 0, 1, 1, 1],
        second: [1, 0, 1, 0, 0, 1],
        ids: [0, 1, 0, 2, 2, 3],
        events: [0, 1, 3, 5]
    },
    {
        name: 'the second column',
        first: [1, 0, 1, 0, 0, 1],
        second: [0, 0, 0, 1, 1, 1],
        ids: [0, 1, 0, 2, 2, 3],
        events: [0, 1, 3, 5]
    },
    {
        name: 'a column of more values',
        first: [2, 0, 2, 1, 0, 1],
        second: [0, 0, 0, 1, 1, 1],
        ids: [0, 1, 0, 2, 3, 2],
        events: [0, 1, 3, 4]
    }
])('signatures are numbered by their first events when $name changes slower', row => {
    const signatures = new EventSignatures(createAttributesLine(row.first, row.second));

    assert.deepEqual([...signatures.ids], row.ids);
    assert.deepEqual([...signatures.events], row.events);
});

test.each([
    { name: 'as many events as a window takes', cumulative: [0, 1, 2, 3], cumulativeEnd: 4, windowEvents: 4 },
    { name: 'an empty axis', cumulative: [0, 0, 0, 0], cumulativeEnd: 0, windowEvents: 2 }
])('a line with $name has no cell records', ({ cumulative, cumulativeEnd, windowEvents }) => {
    const line = createAttributesLine([0, 1, 0, 1]);
    const signatures = new EventSignatures(line);

    assert.equal(signatures.cellRecords(Float64Array.from(cumulative), cumulativeEnd, windowEvents), null);
});

test('mapped span records group events by signature, signature of the mapped event and bin', () => {
    const sourceLine = createAttributesLine([0, 0, 0, 0, 0]);
    const targetBins = [0, 0, 0, 1];
    const targetBin = (target: number) => targetBins[target];

    sourceLine.values.set([1, 2, 4, 8, 16]);

    const source = new EventSignatures(sourceLine);
    const axis = new EventSignatures(createAttributesLine([0, 1, 0, 0]));
    const records = new BinRecords(source.count, true);

    records.addMappedSpan(source, 0, 5, Uint32Array.of(0, 1, 2, 2, 3), axis, targetBin, null);

    const grouped: string[] = [];

    for (let i = 0; i < records.count; i++) {
        grouped.push(
            `signature ${records.signatures[i]}, axis signature ${records.axisSignatures[i]}, ` +
            `bin ${records.bins[i]}: ${records.weights[i]}`
        );
    }

    // One record per group, in any order
    assert.deepEqual(grouped.sort(), [
        'signature 0, axis signature 0, bin 0: 13',
        'signature 0, axis signature 0, bin 1: 16',
        'signature 0, axis signature 1, bin 0: 2'
    ]);
});

test('bin records are shared by aggregations over a grid, replaced for another window and kept for the whole extent', async () => {
    const profile = await createSignaturesProfile();
    const memline = profile.memline!;
    const [breakdown] = memline.breakdowns;
    const [type, space] = memline.attributes;
    const signatures = memline.signatures!;
    const window = () => lineWindow(memline);
    const bin = (attribute: typeof type) => methods.binLineToAxisLine.call({ context: {
        scopeLine: memline, scopeBreakdown: breakdown, data: { profiles: [profile] }, scopeViewport: window()
    } }, memline, attribute, memline, 64);
    const records = () => {
        const { start, end } = window();
        const extent = lineWindow({ ...memline, window: memline.range });

        return signatures.binRecords('own:64', {
            total: end - start,
            step: (end - start) / 64,
            skip: extent.start - start,
            ranges: breakdown.populationWindow.ranges,
            axisRanges: null,
            mapped: false
        });
    };

    bin(type);
    const whole = records();

    assert.ok(whole.complete && whole.count > 0 && whole.count < memline.values.length);
    bin(space);
    (memline.filters.get('category') as SetAttributeFilter).setSelection('exclude', ['script']);
    bin(type);
    assert.equal(records(), whole);

    memline.viewport.setRange(memline.axisTotal * 0.2, memline.axisTotal * 0.3);
    bin(type);
    const zoomed = records();

    assert.ok(zoomed !== whole && zoomed.complete);
    memline.viewport.setRange(memline.axisTotal * 0.6, memline.axisTotal * 0.7);
    bin(type);
    assert.ok(records() !== zoomed && records().complete);

    // Zooming out to the whole extent takes its kept records
    memline.viewport.resetRange();
    bin(type);
    assert.equal(records(), whole);
});

test.each([
    { name: 'mapped to a timeline', mapped: true, cells: false },
    { name: 'without a timeline mapping', mapped: false, cells: false },
    { name: 'with cell records', mapped: true, cells: true }
])('allocation summaries and category bins from signatures equal event aggregation across filters, ranges and grids ($name)', async options => {
    const profile = await createSignaturesProfile(options);
    const memline = profile.memline!;
    const timeline = profile.timeline!;
    const signatures = memline.signatures!;

    // Cells for windows of 1500 events instead of millions; bin queries take the records built here
    if (options.cells) {
        for (const { population } of memline.breakdowns) {
            const cells = signatures.cellRecords(population.cumulative, population.cumulativeEnd, 1500);

            assert.ok(cells !== null && cells.starts.length - 1 === 4000);
        }
    }
    const axisLines = options.mapped ? [timeline, memline] : [memline];
    const filter = (line: ProfileLine, key: string) => line.filters.get(key) as SetAttributeFilter;
    const states: [string, () => void][] = [
        ['unfiltered', () => {}],
        ['memline category', () => filter(memline, 'category').setSelection('exclude', [filter(memline, 'category').options[0].key])],
        ['memline lifespan and space', () => {
            filter(memline, 'allocationLifespan').setSelection('include', ['alive']);
            filter(memline, 'allocationSpace').setSelection('exclude', ['old_space']);
        }],
        ['timeline category', () => filter(timeline, 'category').setSelection('include', [filter(timeline, 'category').options[0].key])],
        ['memline zoom', () => memline.viewport.setRange(memline.axisTotal * 0.23, memline.axisTotal * 0.61)],
        // A narrow gap rejects CPU events between accepted ones that share a bin
        ['timeline ranges with a gap', () => timeline.viewport.setRanges([
            { start: timeline.axisTotal * 0.05, end: timeline.axisTotal * 0.5 },
            { start: timeline.axisTotal * 0.51, end: timeline.axisTotal * 0.95 }
        ])],
        ['timeline zoom with category', () => {
            timeline.viewport.setRange(timeline.axisTotal * 0.31, timeline.axisTotal * 0.74);
            filter(timeline, 'category').setSelection('exclude', [filter(timeline, 'category').options[0].key]);
        }],
        ['memline narrow zoom with category', () => {
            memline.viewport.setRange(memline.axisTotal * 0.4, memline.axisTotal * 0.41);
            filter(memline, 'category').setSelection('include', [filter(memline, 'category').options[0].key]);
        }]
    ];
    let groupedCalls = 0;

    for (const [name, apply] of states) {
        memline.filters.allowAll();
        timeline.filters.allowAll();
        memline.viewport.resetRange();
        timeline.viewport.resetRange();
        apply();

        for (const axisLine of axisLines) {
            for (const breakdown of axisLine === memline ? memline.breakdowns : timeline.breakdowns.slice(0, 1)) {
                const context = { scopeLine: axisLine, scopeBreakdown: breakdown, data: { profiles: [profile] } };
                const viewport = (axisLine === memline ? breakdown : memline.breakdowns[0]).populationViewport;

                groupedCalls += signatures.acceptance(viewport) !== null ? 1 : 0;

                for (const attribute of [...memline.attributes, null]) {
                    for (const count of [1, 3, 7, 64]) {
                        const grouped = methods.binLineToAxisLine.call({ context }, memline, attribute, axisLine, count);

                        memline.signatures = null;
                        const direct = methods.binLineToAxisLine.call({ context }, memline, attribute, axisLine, count);
                        memline.signatures = signatures;

                        assert.deepEqual(grouped, direct, `${name}, ${axisLine.type} ${breakdown.kind}, ${attribute?.name}, ${count} bins`);
                    }
                }

                if (axisLine === memline) {
                    for (const count of [1, 3, 7, 64]) {
                        const grouped = methods.binTreeSamples.call({ context }, breakdown.categories!.all.nodes, count, breakdown);

                        memline.signatures = null;
                        const direct = methods.binTreeSamples.call({ context }, breakdown.categories!.all.nodes, count, breakdown);
                        memline.signatures = signatures;

                        assert.deepEqual(grouped, direct, `${name}, ${breakdown.kind} categories, ${count} bins`);
                    }
                }
            }
        }
    }

    assert.ok(groupedCalls > 0);
});

test('signatures leave acceptance to events when a population filters values that signatures do not keep', async () => {
    const { memline } = await createSignaturesProfile();
    const signatures = memline!.signatures!;
    const viewport = memline!.breakdowns[0].populationViewport;

    assert.notEqual(signatures.acceptance(viewport), null);
    viewport.filter.set({ key: 'other', domain: 'event', size: viewport.samples.length, accepts: new Uint8Array(viewport.samples.length) });
    assert.equal(signatures.acceptance(viewport), null);
});

test('line totals by an attribute are the totals of its signatures', async () => {
    const profile = await createSignaturesProfile();
    const memline = profile.memline!;
    const signatures = memline.signatures!;

    for (let i = 0; i < memline.attributes.length; i++) {
        const { name, values, dict } = memline.attributes[i];
        const expected = new Float64Array(dict.length);

        for (let j = 0; j < values.length; j++) {
            expected[values[j]] += memline.values[j];
        }

        assert.deepEqual(signatures.totalsBy(values, dict.length), expected, name);
    }

    assert.equal(signatures.totalsBy(new Uint32Array(memline.values.length), 1), null);
});
