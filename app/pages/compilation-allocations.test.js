import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import jora from 'jora';
import { methods } from '../jora/index.mjs';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import { prepareLineFilters } from '../prepare/lines/filters.js';
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

test.each(['call-stack', 'location'])('shows original intervals without memory data with %s selected', async kind => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const frame = profile.callFrames.find(frame => frame.name === 'first');
    const event = { name: 'Parse', tm: 100, duration: 20 };
    const records = [{ ...record('Parse', 0, null, null, frame), eventIndex: 0, event }];
    profile.thread = { compilations: records, events: [] };

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
    profile.thread = { compilations: records, events: [] };
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
    profile.thread = { compilations: records, events: [] };
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

    line.attributes.splice(line.attributes.findIndex(attribute => attribute.name === 'allocationOwner'), 1);
    const unbound = contextFor(profile);
    const unboundRows = rows(null, unbound);

    assert.equal(unbound.allocationPopulation, undefined);
    assert.equal(unboundRows.length, 3);
    assert.equal(unboundRows[2].records[0], records[2]);
});
