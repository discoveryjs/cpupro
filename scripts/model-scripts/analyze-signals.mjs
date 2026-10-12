// Signal consistency report: cross-checks CPU samples, allocations and compilation events
// of every profile of a trace. A script module of scripts/run-model.mjs:
//
//   node scripts/run-model.mjs [--option thread=<name|tid>] [--option json] \
//       scripts/model-scripts/analyze-signals.mjs <trace> ...

import { signalWindows, signalMeasurements, compilationPopulation, signalScopes } from '../../app/signals.js';

function percent(value, total) {
    return total > 0 ? (value / total * 100).toFixed(1) + '%' : '-';
}

async function correlationSections(model, profile) {
    const sections = [];

    for (const [type, title] of [['timeline', 'CPU samples'], ['memline', 'Allocations']]) {
        if (!profile[type]) {
            continue;
        }

        const coverage = await model.query(
            `samplesByCompilation('${type}')`, profile, model.getContext()
        );

        if (coverage === null) {
            continue;
        }

        const { categories, events, window } = coverage;

        sections.push({
            title: `${title}: coverage by category`,
            rows: categories.filter(entry => entry.total > 0).map(entry => ({
                category: entry.category?.name ?? 'Unknown', samples: entry.total,
                insideEvents: entry.covered, outsideEvents: entry.outside,
                insideShare: percent(entry.covered, entry.total)
            }))
        }, {
            title: `${title}: event / stage and category`,
            rows: events.filter(event => event.count > 0)
                .sort((first, second) => second.count - first.count)
                .map(event => ({
                    event: event.name ?? 'Outside events', samples: event.count,
                    ...Object.fromEntries(categories.flatMap((entry, index) => entry.total > 0 ? [[
                        entry.category?.name ?? 'Unknown', event.counts[index]
                    ]] : []))
                }))
        });

        if (type === 'memline') {
            sections.push({
                title: 'Allocations outside stages: recording boundaries (assuming IDs 1..N)',
                rows: categories.filter(entry => entry.outside > 0).map(entry => ({
                    category: entry.category?.name ?? 'Unknown',
                    beforeFirstSample: window ? entry.before : 'unknown',
                    withinCpuWindow: window ? entry.outside - entry.before - entry.after : 'unknown',
                    afterLastSample: window ? entry.after : 'unknown'
                }))
            });
        }
    }

    return sections;
}

async function populationSections(model, profile) {
    const sections = [];

    for (const [type, title, unit] of [
        ['timeline', 'CPU samples', 'intervalSumUs'],
        ['memline', 'Allocations', 'bytes']
    ]) {
        if (!profile[type]) {
            continue;
        }

        const distribution = await model.query(
            `sampleDistribution('${type}')`, profile, model.getContext()
        );

        sections.push({
            title: `${title}: categories`,
            rows: distribution.categories.filter(entry => entry.total > 0).map(entry => ({
                category: entry.category?.name ?? 'Unknown',
                count: entry.total,
                countShare: percent(entry.total, distribution.count),
                [unit]: entry.value,
                valueShare: percent(entry.value, distribution.value)
            }))
        }, {
            title: `${title}: value ranges [min, max)`,
            rows: distribution.sizes.filter(size => size.count > 0).map(size => ({
                min: size.min,
                max: size.max,
                count: size.count,
                countShare: percent(size.count, distribution.count),
                [unit]: size.value,
                valueShare: percent(size.value, distribution.value)
            }))
        });
    }

    if (profile.thread?.compilations?.length > 0) {
        sections.push({
            title: 'Compilation events (durations are inclusive, in us)',
            rows: await model.query(compilationPopulation, profile, model.getContext())
        });
    }

    return sections;
}

async function renderTable(model, rows) {
    const columns = Object.keys(rows[0]);
    const cols = columns.map((name, index) => ({
        header: name,
        content: `text:c${index}`
    }));
    const data = rows.map(row =>
        Object.fromEntries(columns.map((name, index) => [`c${index}`, String(row[name])]))
    );
    const { text } = await model.textView.renderString(
        null,
        { view: 'table', cols },
        data,
        model.getContext()
    );

    return text;
}

async function signalsSections(model, profile) {
    const context = model.getContext();
    const signals = await model.query(signalWindows, profile, context);
    const measurements = [];

    for (const { title, unit, when, data } of signalMeasurements) {
        if (await model.query(when, profile, context)) {
            measurements.push({ title, unit, ...await model.query(data, profile, context) });
        }
    }
    const signalRows = signals.map(({ title, count, time, ids }) => ({
        signal: title,
        count: count ?? '',
        timeStart: time?.start ?? '',
        timeEnd: time?.end ?? '',
        idsStart: ids?.start ?? '',
        idsEnd: ids?.end ?? ''
    }));
    const measurementRows = measurements.map(({ title, unit, value, of }) => ({
        measurement: title + (unit ? ` (${unit})` : ''),
        value: value ?? 'unknown',
        of: of ?? '',
        share: typeof value === 'number' && typeof of === 'number' ? percent(value, of) : ''
    }));

    return [
        { title: 'Signals', rows: signalRows },
        { title: 'Measurements', rows: measurementRows }
    ];
}

function matchesThread(thread, filter) {
    if (filter === null) {
        return true;
    }

    return thread?.name === filter || String(thread?.tid) === filter;
}

const EXAMPLE_WIDTH = 80;
const DIAGNOSTICS_QUERY = `
    diagnostics
        .group(=> level + "\\0" + message)
        .({
            level: value[0].level,
            message: value[0].message,
            count: value.size(),
            scopes: value.(scope.join(" / ")).[$].size(),
            example: value[0].details
        })
        .sort(level != "error" asc, count desc)
`;

function diagnosticsRows(groups) {
    return groups.map(({ example, ...group }) => ({
        ...group,
        example: JSON.stringify(example ?? null).slice(0, EXAMPLE_WIDTH)
    }));
}

async function renderReport(model, { thread, tid, sections }) {
    const lines = [`\n# ${thread ?? '(no thread)'} tid=${tid ?? '-'}`];

    for (const { title, rows } of sections) {
        lines.push(`\n## ${title}`);
        lines.push(rows.length > 0 ? await renderTable(model, rows) : '(no data)');
    }

    return lines.join('\n');
}

export default async function analyzeSignals(model, { options }) {
    const threadFilter = options.thread ?? null;
    const diagnostics = diagnosticsRows(await model.queryChain().query(DIAGNOSTICS_QUERY));
    const reports = [];

    const scopes = await model.query(signalScopes, model.data, model.getContext());

    for (const profile of scopes) {
        if (!matchesThread(profile.thread, threadFilter)) {
            continue;
        }

        reports.push({
            thread: profile.thread?.name ?? null,
            tid: profile.thread?.tid ?? null,
            sections: [
                ...await signalsSections(model, profile),
                ...await populationSections(model, profile),
                ...await correlationSections(model, profile)
            ]
        });
    }

    if (options.json !== undefined) {
        return { diagnostics, profiles: reports };
    }

    const texts = ['\n# Diagnostics\n' + (
        diagnostics.length > 0 ? await renderTable(model, diagnostics) : '(no data)'
    )];

    for (const report of reports) {
        texts.push(await renderReport(model, report));
    }

    return texts.join('\n');
}
