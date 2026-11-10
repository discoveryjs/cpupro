import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import jora from 'jora';
import { methods } from '../jora/index.mjs';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import { SetAttributeFilter } from '../prepare/computations/attribute-filter.js';
import type { ProfileLineBreakdown } from '../prepare/lines/types.js';

const pages = new Map();
vi.stubGlobal('discovery', { page: { define(name, config) {
    pages.set(name, config[0]);
} } });
try {
    await import('./all-packages.js');
    await import('./all-modules.js');
    await import('./all-call-frames.js');
    await import('./all-locations.js');
    await import('./all-owners.js');
} finally {
    vi.unstubAllGlobals();
}

const query = jora.setup({ methods: { ...methods, marker: () => ({ href: '#' }) } });
const dimensions = {
    packages: 'packages',
    modules: 'modules',
    'call-frames': 'callFrames',
    locations: 'locations',
    owners: 'owners'
};

// Opens a page as it's rendered: data above the update of its content is computed once, rows below it
// are computed again on every render that follows a change of the metrics
function openPage(name: string, context: object) {
    const page = pages.get(name);
    let data = query(page.data)(null, context);
    let config = page.content;

    while (config.view !== 'update-on-line-metrics-changes') {
        if (config.data) {
            data = query(config.data)(data, context);
        }

        config = config.content;
    }

    const update = config;
    const metrics = update.metrics ? query(update.metrics.slice(1))(data, context) : data;
    const render = () => {
        let rows = data;
        let content = update.content;

        while (!Array.isArray(content)) {
            if (content.data) {
                rows = query(content.data)(rows, context);
            }

            content = content.content;
        }

        return rows;
    };

    return { metrics, render };
}

test.each(Object.keys(dimensions))('all %s page lists every entry and renders values of the viewport and filters again on their changes', async name => {
    const { profile } = await createProfileFixture();

    for (const line of profile.lines) {
        for (const breakdown of line.breakdowns as ProfileLineBreakdown[]) {
            const dimension = breakdown[dimensions[name]] ?? breakdown.callFrames;
            const context = {
                primaryProfile: profile,
                scopeProfile: profile,
                scopeLine: line,
                scopeBreakdown: breakdown
            };
            const { metrics, render } = openPage(name, context);
            const read = () => {
                const rows = render();

                assert.equal(rows.length, dimension.all.dict.entries.length);

                return rows.reduce((sum, row) => sum + row.selfValue, 0);
            };

            assert.equal(metrics, dimension.filtered.dict);

            const extent = methods.lineExtent(line);
            const category = line.filters.get('category') as SetAttributeFilter;

            assert.equal(read(), line.axisTotal);

            line.viewport.selection.setRange(extent.start, extent.start + line.axisTotal / 2);
            const scoped = read();
            assert.ok(scoped > 0 && scoped < line.axisTotal);
            assert.equal(scoped, breakdown.populationFiltered.samplesTotal.reduce((sum, value) => sum + value, 0));

            category.setSelection('include', []);
            assert.equal(read(), 0);

            category.allowAll();
            line.viewport.selection.resetRange();
            assert.equal(read(), line.axisTotal);
        }
    }
});
