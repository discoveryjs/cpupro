import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import jora from 'jora';
import { methods } from '../jora/index.mjs';
import { createProfileFixture, type ProfileFixtureOptions } from '../../test/fixtures/profile.js';
import { findView, findViews } from '../../test/helpers/view-config.js';
import { SetAttributeFilter } from '../prepare/computations/attribute-filter.js';
import { processDisplayNames } from '../prepare/preprocessing/module-names.js';
import type { ProfileLineType } from '../prepare/lines/types.js';
import { sum } from '../../test/helpers/values.js';

const pages = new Map();
const definePage = (name: string, config: object[]) => {
    pages.set(name, config[0]);
};

vi.stubGlobal('discovery', { page: { define: definePage } });
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
const updateView = { view: 'update-on-line-metrics-changes' };

// The context views enclosing the update of the page's content, from the page down
function enclosingContexts(page: object) {
    const contexts = findViews(page, { view: 'context' });
    const enclosing: { data: string }[] = [];

    for (let i = 0; i < contexts.length; i++) {
        if (findViews(contexts[i], updateView).length > 0) {
            enclosing.push(contexts[i]);
        }
    }

    return enclosing;
}

// Opens a page as it's rendered: the data of the views enclosing the update of its content is computed once,
// the rows of the context in the update are computed again on every render that follows a change of the metrics
async function openPage(name: string, type: ProfileLineType, kind: string, options: ProfileFixtureOptions = {}) {
    const { profile } = await createProfileFixture(options);
    const line = profile[type]!;
    const breakdown = line.breakdowns.find(entry => entry.kind === kind)!;
    const context = {
        primaryProfile: profile,
        scopeProfile: profile,
        scopeLine: line,
        scopeBreakdown: breakdown
    };
    const page = pages.get(name);
    const contexts = enclosingContexts(page);
    const updateConfig = findView(page, updateView);
    const rowsConfig = findView(updateConfig, { view: 'context' });
    let data = null;

    for (let i = 0; i < contexts.length; i++) {
        data = query(contexts[i].data)(data, context);
    }

    const metrics = updateConfig.metrics ? query(updateConfig.metrics.slice(1))(data, context) : data;
    const render = () => query(rowsConfig.data)(data, context);

    return { line, breakdown, context, metrics, render };
}

function sumSelfValues(rows: { selfValue: number }[]) {
    return sum(rows.map(row => row.selfValue));
}

const scopes = [
    ['packages', 'timeline', 'call-stack', 'packages'],
    ['packages', 'memline', 'location', 'packages'],
    ['modules', 'timeline', 'call-stack', 'modules'],
    ['modules', 'memline', 'location', 'modules'],
    ['call-frames', 'timeline', 'call-stack', 'callFrames'],
    ['call-frames', 'memline', 'location', 'callFrames'],
    ['locations', 'timeline', 'call-stack', 'locations'],
    ['locations', 'memline', 'location', 'locations'],
    ['owners', 'timeline', 'call-stack', 'owners'],
    ['owners', 'memline', 'location', 'owners']
] as const;

test.each(scopes)(
    'all %s page of a %s %s breakdown lists every entry of its %s',
    async (name, type, kind, dimension) => {
        const { breakdown, render } = await openPage(name, type, kind);
        const entries = breakdown[dimension]!.filtered.dict.entries;
        const rows = render();

        assert.equal(rows.length, entries.length);
        for (let i = 0; i < rows.length; i++) {
            assert.equal(rows[i].entry, entries[i].entry);
        }
    }
);

test.each(scopes)(
    'all %s page of a %s %s breakdown updates on changes of its filtered %s',
    async (name, type, kind, dimension) => {
        const { breakdown, metrics } = await openPage(name, type, kind);

        assert.equal(metrics, breakdown[dimension]!.filtered.dict);
    }
);

test('all locations page of a breakdown without locations lists its call frames', async () => {
    const { breakdown, metrics, render } = await openPage('locations', 'timeline', 'call-stack', { fallback: true });
    const entries = breakdown.callFrames!.filtered.dict.entries;

    assert.equal(breakdown.locations, null);
    assert.equal(metrics, breakdown.callFrames!.filtered.dict);
    assert.equal(render().length, entries.length);
});

test('all modules page names a module by its path in its package or its name, and filters by both', async () => {
    const { breakdown, context } = await openPage('modules', 'timeline', 'call-stack');
    const [modulesContext, filterContext] = enclosingContexts(pages.get('modules'));
    const module = breakdown.modules!.filtered.dict.entries[1].entry;

    // A module of an npm package is named with the name of its package, unlike its path in the package
    module.package.name = 'pkg';
    module.package.registry = 'npm';
    module.name = null;
    processDisplayNames([module]);

    const modules = query(modulesContext.data)(null, context);
    const filterModules = (filter: RegExp) => query(filterContext.data)(modules, { ...context, filter });

    assert.deepEqual(modules.map(entry => [entry.name, entry.nameWithPackageName]), [
        ['(root)', '(root)/(root)'],
        ['compiled.js', 'pkg/compiled.js']
    ]);
    assert.deepEqual(filterModules(/^pkg\//).map(entry => entry.name), ['compiled.js']);
    assert.deepEqual(filterModules(/^\(root\)$/).map(entry => entry.name), ['(root)']);
});

// The timeline has 3 samples of 10us, the memline 4 allocations of 16, 32, 48 and 64 bytes
test.each([
    ['packages', 'timeline', 'call-stack', 30, 15],
    ['packages', 'memline', 'location', 160, 80],
    ['modules', 'timeline', 'call-stack', 30, 15],
    ['modules', 'memline', 'location', 160, 80],
    ['call-frames', 'timeline', 'call-stack', 30, 15],
    ['call-frames', 'memline', 'location', 160, 80],
    ['locations', 'timeline', 'call-stack', 30, 15],
    ['locations', 'memline', 'location', 160, 80],
    ['owners', 'timeline', 'call-stack', 30, 15],
    ['owners', 'memline', 'location', 160, 80]
] as const)(
    'all %s page of a %s %s breakdown renders values of %i, of %i in a viewport and again on changes',
    async (name, type, kind, total, viewport) => {
        const { line, render } = await openPage(name, type, kind);
        const extent = methods.lineExtent(line);
        const category = line.filters.get('category') as SetAttributeFilter;

        assert.equal(sumSelfValues(render()), total);

        line.viewport.selection.setRange(extent.start, extent.start + viewport);
        assert.equal(sumSelfValues(render()), viewport);

        category.setSelection('include', []);
        assert.equal(sumSelfValues(render()), 0);

        category.allowAll();
        line.viewport.selection.resetRange();
        assert.equal(sumSelfValues(render()), total);
    }
);
