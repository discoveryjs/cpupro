/* eslint-env node */
const { supportedFormats } = require('../prepare/index.js');
const { sessionExpandState } = require('./common.js');
const { categoriesFractionBars } = require('./default-page/categories-fraction-bar.js');
const { chartUsedHeap } = require('./default-page/chart-used-heap.js');
const { histAllocationCodeType } = require('./default-page/hist-allocation-code-type.js');
const { histAllocationGcs } = require('./default-page/hist-allocation-gcs.js');
const { histAllocationLifespan } = require('./default-page/hist-allocation-lifespan.js');
const { histAllocationSpaces } = require('./default-page/hist-allocation-spaces.js');
const { histAllocationTypes } = require('./default-page/hist-allocation-types.js');
const { histCodes } = require('./default-page/hist-codes.js');
const { histHeapTotal } = require('./default-page/hist-heap-total.js');
const { pageIndicators } = require('./default-page/page-indicators.js');
const { hierarchicalComponentsTables } = require('./default-page/tables.js');
const { userTimingsTimeline } = require('./default-page/user-timings-timeline.js');

const experimentalFeatures = true;

discovery.nav.primary.append({
    className: 'full-page-mode',
    content: 'text:"Exit full page"',
    when: '#.page = "default" and #.params.flamechartFullpage',
    onClick: () => toggleFullPageFlamechart(false)
});

function toggleFullPageFlamechart(fullpageMode) {
    const params = { ...discovery.pageParams };

    if (fullpageMode) {
        params.flamechartFullpage = true;
    } else {
        delete params.flamechartFullpage;
    }

    discovery.setPageParams(params, true);
    discovery.cancelScheduledRender();

    discovery.dom.pageContent.classList.toggle('flamecharts-fullpage', fullpageMode);
    discovery.nav.render(discovery.dom.nav, discovery.data, discovery.getRenderContext());

    // use timeout since on scroll handler may disable scrolling
    setTimeout(() => {
        const flamechartEl = discovery.dom.container.querySelector('.flamecharts .view-flamechart');
        flamechartEl.classList.add('disable-scrolling');
        flamechartEl.classList.toggle('lock-scrolling', !fullpageMode);
    }, 10);
}

const categoriesTimeline = {
    view: 'block',
    className: 'category-timelines',
    context: '{ ...#, binCount: 500.binCount() }',
    data: `
        $scopeBreakdown: scopeBreakdown();
        $scopeLine: $scopeBreakdown.line;
        $binCount: #.binCount;
        $totalValue: $scopeLine.axisTotal;
        $categoryBins: $scopeBreakdown.categories.all.nodes.binTreeSamples($binCount);

        {
            line: $scopeLine,
            tree: $scopeBreakdown,
            samples: $scopeBreakdown.categories.all.dict.entries
                .[totalValue and (entry.name != 'root' or selfValue)]
                .sort(entry.name.order() asc).({
                $category: entry;
                $bins: $categoryBins[=>entry = $category];

                $category,
                timings: $,
                $totalValue,
                $binCount,
                binSize: (scopeViewport().end - scopeViewport().start) / $binCount,
                bins: $bins.bins,
                totalValueBins: $bins.nestedBins,
                color: $category.name.color(),
                href: $category.marker("category").href
            })
        }
    `,
    content: [
        {
            view: 'line-ruler',
            range: '=scopeViewport()',
            segments: '=#.binCount',
            rangeManager: '=line.range.selection',
            details: {
                view: 'context',
                context: `{
                    ...#,
                    binStart: #.segmentStart,
                    binEnd: #.segmentEnd + 1,
                    noCoverage: scopeLine().lineExtent() |
                        scopeViewport().start + #.timeEnd <= start or scopeViewport().start + #.timeStart >= end
                }`,
                content: [
                    {
                        view: 'block',
                        className: 'timeline-segment-info',
                        context: '{ ...#, scopeViewport: #.detail }',
                        data: 'samples',
                        content: [
                            { view: 'block', content: 'text:`Range: ${#.timeStart.formatValue()} – ${#.timeEnd.formatValue()}`' },
                            { view: 'block', content: ['text:`${"interval".metricName()}: `', 'duration:{ time: #.timeEnd - #.timeStart, total: line.axisTotal }'] },
                            { view: 'block', content: 'text-numeric:`Samples: ${1.countSamples().sum()}`' },
                            { view: 'block', when: '#.noCoverage', content: 'text:"No population coverage"' }
                        ]
                    },
                    {
                        view: 'block',
                        className: 'details-sections',
                        content: [
                            {
                                view: 'block',
                                className: 'details-section',
                                context: '{ ...#, scopeViewport: #.detail }',
                                content: [
                                    {
                                        view: 'block',
                                        className: 'details-section-title',
                                        content: 'text:`${"selfValue".metricName(line)} by category`'
                                    },
                                    {
                                        view: 'list',
                                        className: 'category-timings-list',
                                        data: `
                                            $totals: scopeBreakdown().categories.all.nodes.binTreeSamples(1);
                                            samples.({
                                                $category: category;
                                                ...,
                                                selfValue: $totals[=>entry = $category].value or 0
                                            })
                                        `,
                                        itemConfig: {
                                            className: '=selfValue = 0 ? "no-time"',
                                            postRender: (el, _, data) => el.style.setProperty('--color', data.color),
                                            content: [
                                                'block{ className: "category-name", content: "text:category.name" }',
                                                'metric:{ value: selfValue, total: #.timeEnd - #.timeStart }'
                                            ]
                                        }
                                    }
                                ]
                            },
                            {
                                view: 'block',
                                className: 'details-section',
                                data: `$profile: scopeProfile(); {
                                $base: scopeViewport().start;
                                $start: $base + #.timeStart;
                                $end: $base + #.timeEnd;
                                $points: $profile.thread.counters[=>name="used-heap-size"].values
                                    .selectCountersWithOuters($start, $end)
                                    .[tm >= $start and tm <= $end];
                                min: $points.min(=>tm),
                                max: $points.max(=>tm),
                                $start,
                                $end,
                                $points.({ x: tm, y: value, event })
                            }`,
                                whenData: 'points',
                                content: [
                                    {
                                        view: 'block',
                                        className: 'details-section-title',
                                        content: 'text:"Used heap size"'
                                    },
                                    {
                                        view: 'labeled-value-list',
                                        kind: 'grid',
                                        data: `{ min: points.y.min(), max: points.y.max() } | [
                                        { label: 'Range', value: \`\${min.bytes()} – \${max.bytes()}\` },
                                        { label: 'Range size', value: (max - min).bytes() }
                                    ]`,
                                        label: 'text:label',
                                        value: 'text:value'
                                    },
                                    {
                                        view: 'labeled-value-list',
                                        kind: 'grid',
                                        data: `points.updownSum(=>y) | [
                                        { label: 'Allocated', value: up.bytes() },
                                        { label: 'Garbage Collected', value: down.bytes() },
                                        { label: 'Net Change', value: (up - down).bytes() }
                                    ]`,
                                        label: 'text:label',
                                        value: 'text:value'
                                    }
                                ]
                            },
                            function(el, props, data, context) {
                                const views = discovery.view.getViewStackTrace(context.detailTarget);
                                const section = views?.findLast(view => view.config.rulerDetails);

                                if (section) {
                                    return discovery.view.render(el, section.config.rulerDetails, section.data, {
                                        ...section.context,
                                        ruler: context.ruler,
                                        detail: context.detail,
                                        binStart: context.binStart,
                                        binEnd: context.binEnd
                                    });
                                }
                            }
                        ]
                    }
                ]
            },
            content: [
                'struct'
            ]
        },
        {
            view: 'list',
            className: 'events-x',
            when: 'scopeLine().type = "timeline"',
            data: `scopeProfile() |
                $start: scopeViewport().start;
                $total: scopeViewport().end - $start;
                thread.events.[name in ["MinorGC", "MajorGC"]]
                    .[tm < scopeViewport().end and tm + duration > $start]
                    .({ ..., start: [tm - $start, 0].max(),
                        duration: [tm + duration, scopeViewport().end].min() - [tm, $start].max(), $total })
            `,
            whenData: true,
            limit: false,
            itemConfig: {
                view: 'block',
                className: 'event-x gc-event-x',
                postRender: (el, _, data) => {
                    el.style.setProperty('--start', (100 * data.start / data.total).toFixed(4) + '%');
                    el.style.setProperty('--duration', (100 * data.duration / data.total).toFixed(4) + '%');
                    el.style.setProperty('--color', data.name === 'MinorGC' ? '#f7b26ba0' : data.name === 'MajorGC' ? '#f78c6ba0' : data.name === 'Layout' ? '#6ba0f7a0' : '#6bf78ca0');
                }
            }
        },
        {
            view: 'list',
            className: 'category-timelines-list',
            data: 'samples',
            item: {
                view: 'link',
                className: 'category-timelines-item',
                content: [
                    {
                        view: 'block',
                        className: 'label',
                        postRender: (el, _, data) => el.style.setProperty('--color', data.color),
                        content: 'text:category.name'
                    },
                    {
                        view: 'block',
                        className: 'total-percent',
                        content: 'text:timings.selfValue.totalMetricPercent().replace("%", "")'
                    },
                    {
                        view: 'line-histogram',
                        bins: '=bins',
                        max: '=binSize',
                        binsMax: true,
                        presence: '=totalValueBins',
                        color: '=color'
                    }
                ]
            }
        },

        {
            view: 'expand',
            when: 'scopeProfile().lines.size() > 1',
            ...sessionExpandState('default-timelines-line-mapping-control', false, '$'),
            data: 'scopeProfile().lines',
            className: 'unavailable',
            header: [
                {
                    view: 'block',
                    className: 'expand-label',
                    content: 'text:"Line mapping control"'
                },
                'html:` <span style=\"color: #888\">(debug)</span>`'
            ],
            content: {
                view: 'switch',
                data: `$.({
                    ...binLineToAxisLine(null, scopeLine(), #.binCount)[0],
                    color: "#65b4fda0"
                })`,
                content: [
                    { when: '$', content: [{
                        view: 'list',
                        className: 'category-timelines-list',
                        item: {
                            view: 'link',
                            className: 'category-timelines-item',
                            content: [
                                {
                                    view: 'block',
                                    className: 'label',
                                    content: 'text:entry'
                                },
                                {
                                    view: 'block',
                                    className: 'total-percent',
                                    content: 'text:"–"'
                                },
                                {
                                    view: 'line-histogram',
                                    bins: '=bins',
                                    max: '=max',
                                    scale: '=step ? "linear" : "sqrt"',
                                    binsMax: true,
                                    presence: '=totalValueBins',
                                    color: '=color'
                                }
                            ]
                        }
                    }] },
                    { content: {
                        view: 'block',
                        className: 'data-unavailable',
                        content: 'md:"The profile does not contain the necessary data. Use [V8 log](https://v8.dev/docs/profile) (raw or [preprocessed](https://v8.dev/docs/profile#web-ui-for---prof)) to enable the feature."'
                    } }
                ]
            }
        },
        histCodes,
        histHeapTotal,
        histAllocationTypes,
        histAllocationLifespan,
        histAllocationGcs,
        histAllocationCodeType,
        histAllocationSpaces,
        {
            view: 'context',
            context: '{ ...#, scopeLine: scopeProfile().timeline, scopeBreakdown: null }',
            content: [chartUsedHeap, userTimingsTimeline]
        }
    ]
};

const flamecharts = {
    view: 'context',
    modifiers: {
        view: 'block',
        className: 'toolbar',
        content: [
            {
                view: 'toggle-group',
                name: 'dataset',
                value: '="getSessionSetting".callAction("main-flamechart-dataset", "packages")',
                data: [
                    { text: 'Categories', value: 'categories' },
                    { text: 'Packages', value: 'packages' },
                    { text: 'Modules', value: 'modules' },
                    { text: 'Call frames', value: 'callFrames' }
                ]
            },
            {
                view: 'block',
                className: 'filters',
                content: [
                    // {
                    //     view: 'checkbox',
                    //     name: 'showIdle',
                    //     checked: true,
                    //     content: 'text:"(idle)"',
                    //     tooltip: {
                    //         showDelay: true,
                    //         className: 'cpupro-hint-tooltip',
                    //         content: 'md:"Time when the engine is waiting for tasks or not actively executing any JavaScript code. This could be due to waiting for I/O operations, timer delays, or simply because there\'s no code to execute at that moment."'
                    //     }
                    // },
                    // {
                    //     view: 'checkbox',
                    //     name: 'showProgram',
                    //     checked: true,
                    //     content: 'text:"(program)"',
                    //     tooltip: {
                    //         showDelay: true,
                    //         className: 'cpupro-hint-tooltip',
                    //         content: 'text:"Time spent by the engine on tasks other than executing JavaScript code. This includes overheads like JIT compilation, managing execution contexts, and time in engine\'s internal code. It reflects the internal processing and environment setup necessary for running JavaScript code, rather than the execution of the code itself."'
                    //     }
                    // },
                    // {
                    //     view: 'checkbox',
                    //     name: 'showGC',
                    //     checked: true,
                    //     content: 'text:"(garbage collector)"',
                    //     tooltip: {
                    //         showDelay: true,
                    //         className: 'cpupro-hint-tooltip',
                    //         content: 'text:"When the CPU profile shows time spent in the garbage collector, it indicates the time consumed in these memory management activities. Frequent or prolonged garbage collection periods might be a sign of inefficient memory use in the application, like creating too many short-lived objects or holding onto unnecessary references."'
                    //     }
                    // }
                ]
            },
            {
                view: 'toggle',
                className: 'flamechart-fullpage-toggle',
                content: 'text:"Full page"',
                onToggle: () => toggleFullPageFlamechart(true)
            }
        ]
    },
    content: {
        view: 'flamechart',
        tree: '=scopeBreakdown()[#.dataset].tree',
        timings: '=scopeBreakdown()[#.dataset].filtered.nodes',
        lockScrolling: true,
        postRender(el, config, data, context) {
            el.classList.toggle('lock-scrolling', !context.params.flamechartFullpage);
            if (context.dataset) {
                context.actions.setSessionSetting?.('main-flamechart-dataset', context.dataset);
            }
        }
    }
};

const noDataPageContent = {
    view: 'block',
    className: 'welcome-page',
    content: [
        'app-header:#.model',

        {
            view: 'block',
            when: '#.actions.uploadFile',
            className: 'upload-data',
            content: [
                'preset/upload',
                {
                    view: 'block',
                    className: 'upload-notes',
                    content: 'html:"CPUpro is a server-less application that processes profiles locally without transmitting data elsewhere,<br>it securely opens and analyzes your profiles directly on your device."'
                }
            ]
        },

        {
            view: 'hstack',
            content: [
                {
                    view: 'markdown',
                    source: [
                        'Supported formats:',
                        ...supportedFormats
                    ]
                },

                {
                    view: 'markdown',
                    className: 'supported-formats-tips',
                    source: [
                        '> [!TIP]',
                        '> - The file extension can be arbitrary; the format is determined based on the file\'s content.',
                        '> - The file content may be compressed using `gzip` or `deflate`.'
                    ]
                }
            ]
        },

        {
            view: 'block',
            className: 'examples',
            when: '#.actions.demos',
            content: [
                'text:"Try out example:"',
                'html:"<br>"',
                {
                    view: 'inline-list',
                    data: '"demos".callAction()',
                    whenData: true,
                    item: {
                        view: 'button',
                        className: '=runtime',
                        onClick(_, data) {
                            discovery.loadDataFromUrl(data.url);
                        },
                        content: 'text:title'
                    }
                }
            ]
        }
    ]
};

const pageContent = [
    {
        view: 'timeline-profiles',
        when: experimentalFeatures,
        data: '#.profiles',
        whenData: 'size() > 1'
    },

    pageIndicators,

    {
        view: 'expand',
        ...sessionExpandState('default-timelines', true),
        className: 'timelines trigger-outside',
        header: categoriesFractionBars,
        content: {
            view: 'update-on-line-metrics-changes',
            metrics: '=scopeBreakdown().populationViewport',
            content: categoriesTimeline
        }
    },

    hierarchicalComponentsTables,

    {
        view: 'expand',
        ...sessionExpandState('default-flamegraphs', true),
        className: 'flamecharts trigger-outside',
        header: 'text:"Flame graphs"',
        content: flamecharts
    }
];

discovery.page.define('default', {
    view: 'switch',
    content: [
        {
            when: 'no profiles',
            content: noDataPageContent
        },
        { content: {
            view: 'context',
            data: '#.primaryProfile',
            content: pageContent
        } }
    ]
}, {
    init(pageEl) {
        pageEl.classList.toggle('flamecharts-fullpage', Boolean(discovery.pageParams.flamechartFullpage));
    }
});
