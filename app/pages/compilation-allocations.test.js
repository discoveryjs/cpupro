import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import jora from 'jora';
import { methods } from '../jora/index.mjs';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import { createCompilationRecord } from '../../test/fixtures/compilation.js';
import { findBreakdown } from '../../test/fixtures/lines.js';
import { findContent, findView, contentQuery, findColumn, propertyQuery } from '../../test/helpers/view-config.js';
import { prepareLineFilters } from '../prepare/lines/filters.js';
import { completeCompilationSubjects, prepareCompilationSubjects } from '../prepare/preprocessing/script-compilation.js';
import {
    createMemlineAllocationOwnerAttribute,
    createMemlineAllocationCompilationStageAttribute
} from '../prepare/lines/memline-attributes.mjs';

let page;
vi.stubGlobal('discovery', { page: { define(name, config) {
    assert.equal(name, 'compilations');
    page = config;
} } });
await import('./compilations.js');
vi.unstubAllGlobals();

const query = jora.setup({ methods });

// The same compilation table is shown with and without allocations
const compilationTable = findView(page, { metrics: '=#.allocationPopulation' }).content;
const subjectRows = query(compilationTable.data);
const table = findView(compilationTable, { className: 'all-page-table' });
const summary = findView(compilationTable, { className: 'all-page-summary' });
const allocatedTotal = findView(summary, { when: '#.allocationPopulation' });
const allocated = findColumn(table, 'Allocated');
const allocationSamples = findColumn(table, 'Allocation samples');
const sourceEvent = findColumn(findColumn(table, 'Events').details, 'Source event');
const stages = findView(page, { view: 'expand' });
const stageControls = findView(stages, { view: 'context' });
const stageOptions = findView(stageControls, { view: 'list' });
const allStages = findView(stageControls, { view: 'button' });

function contextFor(profile, kind = 'location') {
    return query(page.content.context)(null, {
        primaryProfile: profile,
        primaryLineType: 'timeline',
        primaryBreakdownKind: kind
    });
}

// Call frames the records resolve to: a subject takes the frame of its first record, as resolution gives it
const recordFrames = new WeakMap();

// A record of script 1 of the profile fixture, it owns allocations of IDs over (allocationStart, allocationEnd]
function record(name, start, allocationStart = null, allocationEnd = null, callFrame = null) {
    const result = createCompilationRecord({
        name,
        scriptId: 1,
        start,
        allocationStart,
        allocationEnd
    });

    recordFrames.set(result, callFrame);

    return result;
}

// The records are created for the functions `first` and `second` of the profile fixture
async function createCompilationProfile(createRecords, options = { noSourceMap: true }) {
    const { profile } = await createProfileFixture(options);
    const first = profile.callFrames.find(frame => frame.name === 'first');
    const second = profile.callFrames.find(frame => frame.name === 'second');
    const records = createRecords(first, second);
    const subjects = prepareCompilationSubjects(records);

    for (let i = 0; i < subjects.length; i++) {
        subjects[i].callFrame = recordFrames.get(subjects[i].records[0]) ?? null;
    }

    completeCompilationSubjects(subjects);
    profile.thread = {
        compilations: records,
        compilationSubjects: subjects,
        events: []
    };

    return { profile, records, first };
}

// Allocations of IDs 1-4 of the memory line of the profile fixture are of 16, 32, 48 and 64 bytes
function addCompilationAttributes(profile, records) {
    profile.memline.attributes.push(
        createMemlineAllocationOwnerAttribute(records, [1, 2, 3, 4]),
        createMemlineAllocationCompilationStageAttribute(records, [1, 2, 3, 4])
    );
}

function addStageAttribute(profile, records) {
    profile.memline.attributes.push(createMemlineAllocationCompilationStageAttribute(records, [1, 2, 3, 4]));
}

function noAttributes() {}

// The first function is compiled with allocations of IDs 1 and 3 and parsed, the second one is compiled
// with an allocation of ID 2
function createAllocations(first, second) {
    return [
        record('Compile', 0, 0, 1, first),
        record('Parse', 0, 1, 1, first),
        record('Compile', 20, 1, 2, second),
        record('Compile', 0, 2, 3, first)
    ];
}

// Stage controls of a page, the filters of its memory line are to be prepared
function stageFilterControls(profile, context) {
    const filterContext = query(stageControls.context)(profile, context);
    const filter = query(stageControls.data)(profile, filterContext);
    const options = query(stageOptions.data)(filter, filterContext);
    const checked = option => propertyQuery(query, stageOptions.item.checked)(option, filterContext);
    const setEnabled = (key, enabled) => {
        const option = options.find(entry => entry.key === key);

        propertyQuery(query, stageOptions.item.onChange)(option, filterContext)(enabled);
    };
    const allowAll = () => propertyQuery(query, allStages.onClick)(filter, filterContext)();

    return { options, checked, setEnabled, allowAll };
}

const counts = rows => rows.map(row => [row.count, row.size, row.events]);

test.each([
    'location',
    'call-stack'
])('allocations are of the filtered population of the %s breakdown of the memory line', async kind => {
    const { profile, records } = await createCompilationProfile(createAllocations);
    const line = profile.memline;

    addCompilationAttributes(profile, records);

    const context = contextFor(profile, kind);

    assert.equal(context.allocationLine, line);
    assert.equal(context.allocationPopulation, findBreakdown(line, kind).populationFiltered);
    assert.equal(query(allocated.colWhen)(null, context), context.allocationPopulation);
    assert.equal(query(allocationSamples.colWhen)(null, context), context.allocationPopulation);
    assert.equal(query(allocatedTotal.when)(null, context), context.allocationPopulation);
});

test.each([
    ['without allocation owners', { noSourceMap: true }, addStageAttribute],
    ['without a memory line', { cpuOnly: true }, noAttributes]
])('a profile %s lists compilations with no allocations', async (_, options, addAttributes) => {
    const { profile, records } = await createCompilationProfile(createAllocations, options);

    addAttributes(profile, records);

    const context = contextFor(profile);

    assert.equal(context.allocationPopulation, undefined);
    assert.deepEqual(counts(subjectRows(null, context)), [[0, 0, 3], [0, 0, 1]]);
    assert.equal(query(allocated.colWhen)(null, context), undefined);
    assert.equal(query(allocationSamples.colWhen)(null, context), undefined);
    assert.equal(query(allocatedTotal.when)(null, context), undefined);
});

test('rows are the prepared subjects of the thread, compilation records are not read again', async () => {
    let reads = 0;
    const countReads = {
        get(target, key) {
            reads++;

            return Reflect.get(target, key);
        }
    };
    const createRecords = first => [
        new Proxy(record('Compile', 10, 0, 1, first), countReads),
        new Proxy(record('Compile', 10, 1, 2, first), countReads)
    ];
    const { profile, records } = await createCompilationProfile(createRecords);

    addCompilationAttributes(profile, records);

    const subjects = profile.thread.compilationSubjects;
    const context = contextFor(profile);

    reads = 0;

    const initial = subjectRows(null, context);

    context.allocationPopulation.setRanges([{ start: 0, end: 16 }]);

    const selected = subjectRows(null, context);

    assert.equal(reads, 0);
    assert.equal(initial[0].records, subjects[0].records);
    assert.equal(selected[0].records, subjects[0].records);
    assert.deepEqual(counts(selected), [[1, 16, 2]]);
});

test.each([
    ['the whole line', null, [[2, 64, 3], [1, 32, 1]]],
    ['a part of an allocation', [{ start: 5, end: 10 }], [[1, 5, 3], [0, 0, 1]]],
    ['parts of allocations of a function', [{ start: 0, end: 16 }, { start: 48, end: 64 }], [[2, 32, 3], [0, 0, 1]]]
])('allocations of a compiled function are its own allocations within %s', async (_, ranges, expected) => {
    const { profile, records } = await createCompilationProfile(createAllocations);

    addCompilationAttributes(profile, records);

    const context = contextFor(profile);

    context.allocationPopulation.setRanges(ranges);

    assert.deepEqual(counts(subjectRows(null, context)), expected);
});

test('different compiled functions resolved to one frame stay separate rows and allocation matrices', async () => {
    const createRecords = enclosing => [
        record('Compile', 10, 0, 1, enclosing),
        record('Compile', 15, 1, 2, enclosing),
        record('Compile', null, 2, 3)
    ];
    const { profile, records, first } = await createCompilationProfile(createRecords);
    const line = profile.memline;

    addCompilationAttributes(profile, records);
    line.attributes.push(
        {
            name: 'allocationType',
            values: new Uint32Array(4),
            dict: ['BYTECODE_ARRAY']
        },
        {
            name: 'allocationLifespan',
            values: new Uint8Array(4),
            dict: ['alive']
        }
    );

    const context = contextFor(profile);
    const rows = subjectRows(null, context);
    const matrixContext = query(allocated.details.context)(rows[0], context);
    const matrixTotal = row => query(allocated.details.data)(row, matrixContext)[0].total;

    assert.deepEqual(rows.map(row => [row.start, row.callFrame, row.size, row.records.length]), [
        [10, first, 16, 1],
        [15, first, 32, 1],
        [null, null, 48, 1]
    ]);
    assert.equal(query('scopeLine()')(null, matrixContext), line);
    assert.deepEqual(rows.map(row => matrixTotal(row).sum), [16, 32, 48]);

    context.allocationPopulation.setRanges([{ start: 1, end: 2 }]);

    assert.deepEqual(matrixTotal(subjectRows(null, context)[0]), { count: 1, sum: 1, min: 1, max: 1 });
});

test('compilations are filtered by the name of their function or of their records', async () => {
    const createRecords = first => [
        record('Compile', 0, null, null, first),
        createCompilationRecord({ name: 'Compile', scriptId: 1, start: 5, functionName: 'named' }),
        record('Compile', 9)
    ];
    const { profile } = await createCompilationProfile(createRecords);
    const context = contextFor(profile);
    const starts = filter => subjectRows(null, { ...context, filter }).map(row => row.start);

    assert.deepEqual(starts(/^first$/), [0]);
    assert.deepEqual(starts(/^named$/), [5]);
});

test('an active filter of another attribute keeps compilation records', async () => {
    const { profile, records } = await createCompilationProfile(createAllocations);

    addCompilationAttributes(profile, records);

    const stop = prepareLineFilters(profile.memline);

    try {
        const context = contextFor(profile);

        profile.memline.filters.get('category').setSelection('include', []);

        assert.deepEqual(counts(subjectRows(null, context)), [[0, 0, 3], [0, 0, 1]]);
    } finally {
        stop();
    }
});

test.each([
    ['Allocated', { size: 1 }, { size: 2 }],
    ['Allocation samples', { count: 1 }, { count: 2 }],
    ['Events', { events: 1 }, { events: 2 }],
    ['Source', { sourceSize: 1 }, { sourceSize: 2 }]
])('the %s column sorts larger values first', (header, smaller, larger) => {
    assert.deepEqual(query(`sort(${findColumn(table, header).sorting})`)([smaller, larger]), [larger, smaller]);
});

test('source details are shown for compilations of resolved functions only', () => {
    assert.equal(query(findColumn(table, 'Source').detailsWhen)({ callFrame: null }), null);
});

test('compilations are sorted by allocated size, then by events', () => {
    const rows = [
        { size: 0, events: 1 },
        { size: 32, events: 1 },
        { size: 0, events: 3 },
        { size: 64, events: 1 }
    ];

    assert.deepEqual(query(table.data)(rows), [rows[3], rows[1], rows[2], rows[0]]);
});

test('stage options are the compilation stages of the allocations, all enabled at first', async () => {
    const { profile, records } = await createCompilationProfile(createAllocations);
    const line = profile.memline;

    addCompilationAttributes(profile, records);

    const stop = prepareLineFilters(line);

    try {
        const context = contextFor(profile);
        const controls = stageFilterControls(profile, context);
        const stageAttribute = line.attributes.find(attribute => attribute.name === 'allocationCompilationStage');
        const updates = findView(stages, { view: 'update-on-line-metrics-changes' });

        assert.equal(query(stages.when)(null, context), stageAttribute);
        assert.equal(propertyQuery(query, updates.metrics)(null, context), line.filters);
        assert.deepEqual(controls.options.map(option => [option.key, controls.checked(option)]), [
            ['Compile', true],
            ['Parse', true]
        ]);
    } finally {
        stop();
    }
});

test('a profile without compilation stages of allocations has no stage options', async () => {
    const { profile } = await createCompilationProfile(createAllocations);

    assert.equal(query(stages.when)(null, contextFor(profile)), null);
});

test('a disabled stage hides its records and subjects left without them, until all stages are allowed', async () => {
    const { profile, records } = await createCompilationProfile(createAllocations);

    addCompilationAttributes(profile, records);

    const stop = prepareLineFilters(profile.memline);

    try {
        const context = contextFor(profile);
        const controls = stageFilterControls(profile, context);

        controls.setEnabled('Compile', false);

        const filtered = subjectRows(null, context);

        assert.deepEqual(counts(filtered), [[0, 0, 1]]);
        assert.deepEqual(filtered[0].records, [records[1]]);
        assert.equal(controls.checked(controls.options[0]), false);

        controls.allowAll();

        assert.deepEqual(counts(subjectRows(null, context)), [[2, 64, 3], [1, 32, 1]]);
    } finally {
        stop();
    }
});

test('a compilation takes the most advanced state of complete records, activated for compiled functions', async () => {
    const createRecords = (first, second) => [
        record('HandleInterrupts', null),
        record('PreParse', 10, 0, 1, first),
        record('CompileIgnition', 10, 1, 2, first),
        record('FinalizeUnoptimizedCompilationJob', 10, 2, 2, first),
        record('CompileIgnition', 10, 2, 2, first),
        record('PreParseCached', 20, 2, 2, second),
        record('ParseFunction', 30, 2, 2, second),
        record('CompileIgnition', 0, 2, 3, { ...first, kind: 'script' }),
        Object.assign(record('CompileIgnition', 40, 3, 3, second), { duration: null })
    ];
    const { profile, records } = await createCompilationProfile(createRecords);

    addCompilationAttributes(profile, records);

    const context = contextFor(profile);
    const rows = subjectRows(null, context);
    const summaryCount = prefix => contentQuery(query, findContent(summary, prefix))(rows, context);

    assert.deepEqual(rows.map(row => [row.state, row.activated, row.events]), [
        ['unobserved', false, 1],
        ['compiled', true, 4],
        ['pre-parsed', false, 1],
        ['parsed', false, 1],
        ['compiled', false, 1],
        ['unobserved', false, 1]
    ]);
    assert.equal(summaryCount('text-numeric:size()'), 6);
    assert.equal(summaryCount('text-numeric:.[callFrame.kind'), 4);
    assert.equal(summaryCount('text-numeric:.[activated]'), 1);
});

test('stage filters and allocation ranges keep the state of a compilation', async () => {
    const createRecords = first => [
        record('PreParse', 10, 0, 1, first),
        record('CompileIgnition', 10, 1, 2, first)
    ];
    const { profile, records } = await createCompilationProfile(createRecords);

    addCompilationAttributes(profile, records);

    const stop = prepareLineFilters(profile.memline);

    try {
        const context = contextFor(profile);

        profile.memline.filters.get('allocationCompilationStage').setSelection('include', ['PreParse']);
        context.allocationPopulation.setRanges([{ start: 0, end: 1 }]);

        assert.deepEqual(subjectRows(null, context).map(row => [row.state, row.activated, row.events]), [
            ['compiled', true, 1]
        ]);
    } finally {
        stop();
    }
});

test.each([
    'call-stack',
    'location'
])('compilation records link their source events without memory data with %s selected', async kind => {
    const event = { name: 'Parse', tm: 100, duration: 20 };
    const createRecords = first => [{
        ...record('Parse', 0, null, null, first),
        eventIndex: 0,
        event
    }];
    const { profile, records } = await createCompilationProfile(createRecords, { cpuOnly: true });
    const context = contextFor(profile, kind);
    const [row] = subjectRows(null, context);

    assert.equal(row.records[0], records[0]);
    assert.equal(query(sourceEvent.detailsWhen)(records[0], context), event);
    assert.equal(query(sourceEvent.details.slice('struct:'.length))(records[0], context), event);
    assert.equal(query(sourceEvent.detailsWhen)({ ...records[0], event: null }, context), null);
});

// The source of the function is of 32 characters, its range starts at a position of the source
test.each([
    ['two-byte storage', { bytesPerChar: 2 }, 0, 64],
    ['a range within the source', { bytesPerChar: 1 }, 9, 23],
    ['no source metrics', null, 0, null]
])('the source size of a function is in script payload bytes, with %s', async (_, sourceMetrics, start, size) => {
    const source = 'function first() { return "\u0100"; }';
    const createRecords = first => {
        const script = {
            ...first.script,
            source,
            sourceMetrics
        };
        const frame = {
            ...first,
            script,
            start,
            end: source.length
        };

        return [record('CompileIgnition', 0, null, null, frame)];
    };
    const { profile } = await createCompilationProfile(createRecords);

    assert.equal(subjectRows(null, contextFor(profile))[0].sourceSize, size);
});
