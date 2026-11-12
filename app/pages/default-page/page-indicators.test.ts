import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { methods } from '../../jora/index.mjs';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { findView, findViews, propertyQuery } from '../../../test/helpers/view-config.js';
import { pageIndicators } from './page-indicators.js';
import { SetAttributeFilter } from '../../prepare/computations/attribute-filter.js';
import type { ProfileLine } from '../../prepare/lines/types.js';

const query = jora.setup({ methods });
// Values are compared unformatted
const valueQuery = jora.setup({ methods: { ...methods, formatValue: (value: number) => value } });

const runtime = findView(pageIndicators, { title: 'Runtime' });
const samplingInterval = findView(pageIndicators, { title: 'Sampling interval' });
// Profile values in the order of the page: total, samples, call tree nodes and call frames
const viewportValues = findViews(pageIndicators, { metrics: '=populationViewport' });
const selectionGroup = findView(pageIndicators, { className: 'selected' });
const selection = findView(selectionGroup, { view: 'context' });
const selectionSamples = findView(selectionGroup, { title: 'Samples' });
const selectedInterval = findView(selectionGroup, { title: '="interval".metricName()' });

async function createLine(name: string) {
    const { profile } = await createProfileFixture();
    const line: ProfileLine = profile[name as 'timeline' | 'memline']!;

    return { profile, line, breakdown: line.breakdowns[0] };
}

function acceptNothing(line: ProfileLine) {
    (line.filters.get('category') as SetAttributeFilter).setSelection('include', []);
}

function viewFirstUnit(line: ProfileLine) {
    const extent = methods.lineExtent(line);

    line.viewport.selection.setRange(extent.start, extent.start + 1);
}

function viewAll() {}

test.each([
    ['a known runtime', { code: 'node', name: 'Node.js', engine: 'V8' }, 'runtime node', 'Node.js'],
    ['an unknown runtime', { code: 'unknown', name: 'Unknown', engine: 'V8' }, 'runtime unknown', 'Unknown/V8']
])('the runtime indicator names %s', (_, profileRuntime, className, value) => {
    const profile = { runtime: profileRuntime };

    assert.equal(propertyQuery(query, runtime.className)(profile), className);
    assert.equal(propertyQuery(query, runtime.value)(profile), value);
});

test('metric hints name and define the metric of the line, the total notes the viewport and filters', async () => {
    const { line } = await createLine('memline');
    const context = { scopeLine: line };
    const total = findView(pageIndicators, { title: '="axis".metricName()' });
    const totalHint = propertyQuery(query, total.hint.source)(null, context);
    const samplingHint = propertyQuery(query, samplingInterval.hint.source)(null, context);

    assert.ok(totalHint.startsWith('#### Memory allocated\n\nThe total memory allocated during the profiling session'));
    assert.ok(totalHint.endsWith('\n\nIn the viewport, for the samples accepted by the filters.'));
    assert.equal(
        samplingHint,
        '#### Sampling interval\n\nThe minimum memory allocated between samples taken during the profiling session.'
    );
});

test.each([
    ['timeline', 'μs'],
    ['memline', 'b']
])('the sampling interval of a %s is in its units', async (name, unit) => {
    const { line } = await createLine(name);
    const context = { scopeLine: line };

    assert.equal(propertyQuery(query, samplingInterval.value)(null, context), line.sourceInfo.samplesInterval);
    assert.equal(propertyQuery(query, samplingInterval.unit)(null, context), unit);
});

test('profile values are of the scope breakdown, debounced on changes of its viewport population', async () => {
    const { profile, line, breakdown } = await createLine('timeline');
    const context = { scopeProfile: profile, scopeLine: line, scopeBreakdown: breakdown };

    assert.equal(viewportValues.length, 4);

    for (let i = 0; i < viewportValues.length; i++) {
        const view = viewportValues[i];
        const data = query(view.data)(profile, context);

        assert.equal(data, breakdown);
        assert.equal(propertyQuery(query, view.metrics)(data, context), breakdown.populationViewport);
        assert.equal(view.debounce, true);
    }
});

test.each([
    ['timeline', 'the whole line', viewAll, [30, 3, 3, 3]],
    ['timeline', 'the viewport', viewFirstUnit, [1, 1, 2, 2]],
    ['timeline', 'samples accepted by filters', acceptNothing, [0, 0, 0, 0]],
    ['memline', 'the whole line', viewAll, [160, 4, 3, 3]],
    ['memline', 'the viewport', viewFirstUnit, [1, 1, 2, 2]],
    ['memline', 'samples accepted by filters', acceptNothing, [0, 0, 0, 0]]
])('profile values of a %s count %s', async (name, _, narrow, expected) => {
    const { profile, line, breakdown } = await createLine(name);
    const context = { scopeProfile: profile, scopeLine: line, scopeBreakdown: breakdown };
    const values: number[] = [];

    narrow(line);

    for (let i = 0; i < viewportValues.length; i++) {
        const view = viewportValues[i];
        const data = query(view.data)(profile, context);

        values.push(propertyQuery(valueQuery, findView(view, { view: 'text-with-unit' }).value)(data, context));
    }

    assert.deepEqual(values, expected);
});

test.each([
    ['no selection', null, false],
    ['an empty selection', [], true],
    ['a selection', [{ start: 1, end: 2 }], true]
])('selection indicators are shown with %s of the line', async (_, ranges, shown) => {
    const { line } = await createLine('timeline');

    line.range.setRanges(ranges);

    assert.equal(query(selection.when)(null, { scopeLine: line }), shown);
});

test('selection indicators follow the line range, selected samples follow the filtered population', async () => {
    const { line, breakdown } = await createLine('timeline');
    const context = { scopeLine: line, scopeBreakdown: breakdown };
    const rangeUpdates = findView(selectionGroup, { view: 'update-on-line-metrics-changes' });
    const samplesUpdates = findView(selectionGroup, { metrics: '=scopeBreakdown().populationFiltered' });

    line.range.setRanges([{ start: 0, end: 15 }]);

    assert.equal(propertyQuery(query, rangeUpdates.metrics)(null, context), line.range);
    assert.equal(propertyQuery(query, samplesUpdates.metrics)(null, context), breakdown.populationFiltered);
    assert.equal(propertyQuery(query, selectionSamples.value)(null, context), 2);
});

const overlapping = [{ start: -10, end: 15 }, { start: 5, end: 20 }, { start: 25, end: 35 }];

test.each([
    ['timeline', 'overlapping ranges', overlapping, 25],
    ['timeline', 'a range beyond the end', [{ start: 20, end: 50 }], 10],
    ['timeline', 'ranges outside', [{ start: 200, end: 210 }], 0],
    ['timeline', 'no ranges', [], 0],
    ['memline', 'overlapping ranges', overlapping, 30],
    ['memline', 'a range beyond the end', [{ start: 150, end: 200 }], 10]
])('the selected interval of a %s is the union of %s within its coverage', async (name, _, ranges, length) => {
    const { line } = await createLine(name);

    line.range.setRanges(ranges);

    assert.equal(propertyQuery(valueQuery, selectedInterval.value)(null, { scopeLine: line }), length);
});

test.each([
    ['timeline', 30, '0.0 ms', 'Duration'],
    ['memline', 160, '0.2Kb', 'Memory allocated']
])('the selected interval of a %s is formatted and named by the line', async (name, end, value, title) => {
    const { line } = await createLine(name);
    const context = { scopeLine: line };

    line.range.setRanges([{ start: 0, end }]);

    assert.equal(propertyQuery(query, selectedInterval.value)(null, context), value);
    assert.equal(propertyQuery(query, selectedInterval.title)(null, context), title);
});

test('the selected interval does not depend on filters', async () => {
    const { line } = await createLine('timeline');

    line.range.setRanges([{ start: 0, end: 20 }]);
    acceptNothing(line);

    assert.equal(propertyQuery(valueQuery, selectedInterval.value)(null, { scopeLine: line }), 20);
});
