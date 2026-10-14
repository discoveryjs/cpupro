import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import jora from 'jora';
import { methods } from '../jora/index.mjs';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import { prepareLineFilters } from '../prepare/lines/filters.js';
import { prepareCompilationSubjects } from '../prepare/preprocessing/script-compilation.js';
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
const table = page.content.content.content[1].content;
const rows = query(table.data);
const contextFor = (profile, kind = 'location') => query(page.content.context)(null, {
    primaryProfile: profile, primaryLineType: 'timeline', primaryBreakdownKind: kind
});

function record(name, start, allocationStart = null, allocationEnd = null, callFrame = null) {
    return {
        name, tm: 100, duration: 20, scriptId: 1, start, end: null, line: null, column: null,
        functionName: null, allocationStart, allocationEnd, eventIndex: null, event: null, callFrame
    };
}

function compilationAttributes(records, ids) {
    return [
        createMemlineAllocationOwnerAttribute(records, ids),
        createMemlineAllocationCompilationStageAttribute(records, ids)
    ];
}

function setCompilations(profile, records) {
    profile.thread = { compilations: records, compilationSubjects: prepareCompilationSubjects(records), events: [] };
}

test('source size uses script payload bytes and preserves unavailable metrics', async () => {
    const { profile } = await createProfileFixture({ noSourceMap: true });
    const frame = { ...profile.callFrames.find(frame => frame.name === 'first') };
    frame.script.source = 'function first() { return "\u0100"; }';
    frame.start = 0;
    frame.end = frame.script.source.length;
    frame.script.sourceMetrics = { ...frame.script.sourceMetrics, bytesPerChar: 2 };
    const records = [record('CompileIgnition', frame.start, null, null, frame)];
    setCompilations(profile, records);

    assert.equal(rows(null, contextFor(profile))[0].sourceSize, (frame.end - frame.start) * 2);
    frame.script.sourceMetrics = null;
    setCompilations(profile, records);
    assert.equal(rows(null, contextFor(profile))[0].sourceSize, null);
});

test('activation counts compiled function identities, not preparsing, scripts or repeated stages', async () => {
    const { profile } = await createProfileFixture({ noSourceMap: true });
    const line = profile.memline;
    const first = profile.callFrames.find(frame => frame.name === 'first');
    const second = profile.callFrames.find(frame => frame.name === 'second');
    const script = { ...first, kind: 'script' };
    const records = [
        record('PreParse', 10, 0, 1, first),
        record('CompileIgnition', 10, 1, 2, first),
        record('FinalizeUnoptimizedCompilationJob', 10, 2, 2, first),
        record('CompileIgnition', 10, 2, 2, first),
        record('PreParseCached', 20, 2, 2, second),
        record('ParseFunction', 30, 2, 2, second),
        record('CompileIgnition', 0, 2, 3, script),
        { ...record('CompileIgnition', 40, 3, 3, second), duration: null },
        record('HandleInterrupts', null)
    ];
    setCompilations(profile, records);
    line.attributes.push(...compilationAttributes(records, [1, 2, 3, 4]));
    const stop = prepareLineFilters(line);

    try {
        const context = contextFor(profile);
        const result = rows(null, context);
        const activatedCount = table.content[1].content[2].content[1].slice('text-numeric:'.length);

        assert.deepEqual(result.map(row => [row.state, row.activated]), [
            ['compiled', true], ['pre-parsed', false], ['parsed', false],
            ['compiled', false], ['unobserved', false], ['unobserved', false]
        ]);
        assert.equal(query(activatedCount)(result, context), 1);
        assert.equal(result[0].events, 4);
        line.filters.get('allocationCompilationStage').setSelection('include', ['PreParse']);
        const filtered = rows(null, context);
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].events, 1);
        assert.equal(filtered[0].state, 'compiled');
        assert.equal(query(activatedCount)(filtered, context), 1);
        context.allocationPopulation.setRanges([{ start: 1, end: 2 }]);
        assert.equal(query(activatedCount)(rows(null, context), context), 1);
    } finally {
        stop();
    }
});

test('range updates reuse prepared subjects without rereading compilation events', async () => {
    const { profile } = await createProfileFixture({ noSourceMap: true });
    const frame = profile.callFrames.find(frame => frame.name === 'first');
    let reads = 0;
    const records = Array.from({ length: 1000 }, () => new Proxy(record('CompileIgnition', 10, 0, 1, frame), {
        get(target, key) {
            if (key === 'name' || key === 'duration' || key === 'start' || key === 'scriptId') {
                reads++;
            }
            return Reflect.get(target, key);
        }
    }));
    setCompilations(profile, records);
    profile.memline.attributes.push(...compilationAttributes(records, [1, 2, 3, 4]));
    const subjects = profile.thread.compilationSubjects;
    const context = contextFor(profile);
    reads = 0;

    const initial = rows(null, context);
    context.allocationPopulation.setRanges([{ start: 1, end: 2 }]);
    const selected = rows(null, context);

    assert.equal(reads, 0);
    assert.equal(profile.thread.compilationSubjects, subjects);
    assert.equal(initial[0].records, subjects[0].records);
    assert.equal(selected[0].records, subjects[0].records);
    assert.equal(selected[0].events, 1000);
    assert.equal(selected[0].activated, true);
});

test.each(['call-stack', 'location'])('shows original intervals without memory data with %s selected', async kind => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const frame = profile.callFrames.find(frame => frame.name === 'first');
    const event = { name: 'Parse', tm: 100, duration: 20 };
    const records = [{ ...record('Parse', 0, null, null, frame), eventIndex: 0, event }];
    setCompilations(profile, records);

    const context = contextFor(profile, kind);
    const result = rows(null, context);
    const eventColumn = table.content[0].cols[2].details.cols[5];

    assert.equal(context.allocationPopulation, undefined);
    assert.equal(result.length, 1);
    assert.equal(result[0].callFrame, frame);
    assert.equal(result[0].records[0], records[0]);
    assert.equal(result[0].events, 1);
    assert.equal('selfTime' in result[0], false);
    assert.equal(query(eventColumn.detailsWhen)(records[0], context), event);
    assert.equal(query(eventColumn.details.slice('struct:'.length))(records[0], context), event);
    assert.equal(query(eventColumn.detailsWhen)({ ...records[0], event: null }, context), null);
});

test('uses selected memory population and compiled-function identities without losing stage/range filters', async () => {
    const { profile } = await createProfileFixture({ noSourceMap: true });
    const line = profile.memline;
    const first = profile.callFrames.find(frame => frame.name === 'first');
    const second = profile.callFrames.find(frame => frame.name === 'second');
    const records = [
        record('Compile', 0, 0, 1, first), record('Parse', 0, 1, 1, first),
        record('Compile', 20, 1, 2, second), record('Compile', 0, 2, 3, first)
    ];
    setCompilations(profile, records);
    line.attributes.push(...compilationAttributes(records, [1, 2, 3, 4]));
    const stop = prepareLineFilters(line);

    try {
        const context = contextFor(profile);
        const population = line.breakdowns.find(breakdown => breakdown.kind === 'location').populationFiltered;
        const result = rows(null, context);

        assert.equal(context.allocationPopulation, population);
        assert.deepEqual(result.map(row => [row.count, row.size, row.events]), [[2, 64, 3], [1, 32, 1]]);
        assert.deepEqual(result[0].records, [records[0], records[1], records[3]]);

        const other = contextFor(profile, 'call-stack');
        other.allocationPopulation.updateMask(mask => mask.fill(0x80000000));
        assert.equal(rows(null, other).reduce((total, row) => total + row.size, 0), 0);
        assert.equal(rows(null, context).reduce((total, row) => total + row.size, 0), 96);

        const controls = page.modifiers[0].content[2].content.content;
        const filterContext = query(controls.context)(profile, context);
        const filterData = query(controls.data)(profile, filterContext);
        const options = query(controls.content[0].data)(filterData, filterContext);
        const checkbox = controls.content[0].item;

        assert.deepEqual(options.map(option => option.key), ['Compile', 'Parse']);
        query(checkbox.onChange.slice(1))(options.find(option => option.key === 'Compile'), filterContext)(false);
        assert.deepEqual(rows(null, context).map(row => [row.size, row.events]), [[0, 1]]);
        query(controls.content[1].onClick.slice(1))(filterData, filterContext)();
        population.setRanges([{ start: 5, end: 10 }]);
        assert.deepEqual(rows(null, context).map(row => [row.size, row.events]), [[5, 3], [0, 1]]);
        population.setRanges([{ start: 0, end: 16 }, { start: 48, end: 64 }]);
        assert.deepEqual(rows(null, context).map(row => [row.count, row.size]), [[2, 32], [0, 0]]);
    } finally {
        stop();
    }
});

test('different compiled functions resolved to one frame stay separate rows and matrix selections', async () => {
    const { profile } = await createProfileFixture({ noSourceMap: true });
    const line = profile.memline;
    const enclosing = profile.callFrames.find(frame => frame.name === 'first');
    const records = [record('Compile', 10, 0, 1, enclosing), record('Compile', 15, 1, 2, enclosing), record('Compile', null, 2, 3)];
    setCompilations(profile, records);
    line.attributes.push(
        ...compilationAttributes(records, [1, 2, 3, 4]),
        { name: 'allocationType', values: new Uint32Array(4), dict: ['BYTECODE_ARRAY'] },
        { name: 'allocationLifespan', values: new Uint8Array(4), dict: ['alive'] }
    );
    const context = contextFor(profile);
    const result = rows(null, context);
    const details = table.content[0].cols[0].details;
    const matrixContext = query(details.context)(result[0], context);

    assert.deepEqual(result.map(row => [row.start, row.callFrame, row.size, row.records.length]), [
        [10, enclosing, 16, 1], [15, enclosing, 32, 1], [null, null, 48, 1]
    ]);
    assert.equal(query('scopeLine()')(null, matrixContext), line);
    assert.equal(query('10000.unit()')(null, matrixContext), '10.0Kb');

    for (const row of result) {
        assert.equal(query(details.data)(row, matrixContext)[0].total.sum, row.size);
    }

    context.allocationPopulation.setRanges([{ start: 1, end: 2 }]);
    const partial = rows(null, context)[0];
    assert.equal(partial.size, 1);
    assert.deepEqual(query(details.data)(partial, matrixContext)[0].total, { count: 1, sum: 1, min: 1, max: 1 });

    line.attributes.splice(line.attributes.findIndex(attribute => attribute.name === 'allocationOwner'), 1);
    const unbound = contextFor(profile);
    const unboundRows = rows(null, unbound);

    assert.equal(unbound.allocationPopulation, undefined);
    assert.equal(unboundRows.length, 3);
    assert.equal(unboundRows[2].records[0], records[2]);
});
