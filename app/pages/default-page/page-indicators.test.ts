import assert from 'node:assert/strict';
import { test } from 'vitest';
import jora from 'jora';
import { methods } from '../../jora/index.mjs';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { pageIndicators } from './page-indicators.js';
import { SetAttributeFilter } from '../../prepare/computations/attribute-filter.js';

const query = jora.setup({ methods });
const group = pageIndicators.content.find(entry => entry.className === 'selected')!;
assert.ok(group.content && !Array.isArray(group.content));
const selected = group.content.content;
const indicator = selected.content.at(-1)!;
assert.ok(indicator.value && indicator.title);
const value = query(indicator.value.slice(1));
const lengthValue = jora.setup({ methods: { ...methods, formatValue: (value: number) => value } })(indicator.value.slice(1));
const title = query(indicator.title.slice(1));
const visible = query(selected.when);

test('selection indicators measure the union within line coverage in time or bytes', async () => {
    const { profile } = await createProfileFixture({ startTime: 100 });
    for (const line of [profile.timeline!, profile.memline!]) {
        const context = { scopeLine: line };
        assert.equal(visible({}, context), false);
        line.range.setRanges([{ start: -10, end: 15 }, { start: 5, end: 20 }, { start: 25, end: 35 }]);
        const length = 20 + Math.min(35, line.axisTotal) - 25;
        assert.equal(lengthValue({}, context), length);
        assert.equal(value({}, context), line.formatValue(length));
        assert.equal(title({}, context), line.metricName('interval'));
        assert.equal(visible({}, context), true);
        const requested = line.range.selection.ranges;
        const filter = line.filters.get('category');
        assert.ok(filter instanceof SetAttributeFilter);
        filter.setSelection('include', []);
        assert.equal(lengthValue({}, context), length);
        assert.equal(value({}, context), line.formatValue(length));
        assert.equal(line.range.selection.ranges, requested);
        line.range.setRange(line.axisTotal + 1, line.axisTotal + 10);
        assert.equal(lengthValue({}, context), 0);
        assert.equal(value({}, context), line.formatValue(0));
        line.range.setRanges([]);
        assert.equal(lengthValue({}, context), 0);
        assert.equal(value({}, context), line.formatValue(0));
        assert.equal(visible({}, context), true);
        line.range.resetRange();
        assert.equal(visible({}, context), false);
    }
});
