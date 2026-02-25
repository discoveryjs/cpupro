/* eslint-env node */
const { resolveScopeProfileLine } = require('../jora/profile.js');
const { supportedFormats } = require('../prepare/index.js');
const { sessionExpandState, primaryLineSwitcher } = require('./common.js');
const { categoriesFractionBars } = require('./default-page/categories-fraction-bar.js');
const { chartUsedHeap } = require('./default-page/chart-used-heap.js');
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
    data: `
        $scopeLine: scopeLine();
        $profile: $scopeLine.profile;
        $binCount: 500;
        $totalValue: $scopeLine.axisTotal;
        $binSamples: $binCount.countSamples();

        {
            line: $scopeLine,
            samples: $scopeLine.dict.categories.all.entries.[totalValue and entry.name != 'root'].({
                $category: entry;
                $tree: $profile.categoriesTree;
                $subtree: $tree.subtreeSamples($category);
                $totalValueBins: $subtree.mask.binCallsFromMask($binCount);

                $category,
                timings: $,
                $totalValue,
                $binCount,
                binSize: $totalValue / $binCount,
                $binSamples,
                bins: $tree.binCalls($category, $binCount),
                $totalValueBins,
                color: $category.name.color(),
                href: $category.marker("category").href
            }),
            functionCodes: codes |? {
                $countByTopTier: @.codesByCallFrame.group(=> topTier).({ tier: key, count: value.size() });
                $codes: sort(tm asc);
                $totalBins: $codes.binScriptFunctionCodesTotal();
                $maxTotal: $totalBins.fnCount.max();
                $byTierBins: $totalBins.byTier.({
                    $tier: $[0];
                    $bins: $[1];

                    name: $tier,
                    color: $tier.color(),
                    $bins,
                    max: $bins.max(),
                    $maxTotal,
                    maxTier: $countByTopTier[=> tier = $tier].count or 0
                }).[max];
                
                $countByTopTier,
                compilations: $codes,
                compilationBins: $codes.binScriptFunctionCodes(),
                totalBins: $totalBins.fnCount,
                totalColor: '#7fb2f7a0',
                codesTotalColor: "compilation".color(),
                byTier: $byTierBins,
                byTierMax: $maxTotal
            },
            heap: heap | events ? {
                $totalHeapSize: events.binHeapTotal($binCount, capacity);
                $new: events.binHeapEvents("new", $binCount);
                $delete: events.binHeapEvents("delete", $binCount);

                available,
                $totalHeapSize,
                minTotal: $totalHeapSize.min(),
                maxTotal: $totalHeapSize.max(),
                $new,
                newTotal: $new.sum(),
                $delete,
                deleteTotal: $delete.sum(),
                maxNewDelete: [$new.max(), $delete.max()].max()
            },
            lineMappingControl: $profile.lines.(
                { ...binLineToAxisLine(null, null, $scopeLine, 500)[0], color: "#65b4fda0" }
            ),
            memline: $profile | memline ? {
                byType: (memline | valueTypes and valueTypesDict)
                    ? memline.binLineToAxisLine(memline.valueTypes, memline.valueTypesDict, $scopeLine, 500),
                bySpace: (memline | valueSpaces and valueSpacesDict)
                    ? memline.binLineToAxisLine(memline.valueSpaces, memline.valueSpacesDict, $scopeLine, 500),
                byGc: (memline | valueLifespans and valueLifespansDict)
                    ? memline.binLineToAxisLine(memline.valueLifespans, memline.valueLifespansDict, $scopeLine, 500),
                byGcEpoch: (memline | valueGcEpochs and valueGcEpochsDict)
                    ? memline.binLineToAxisLine(memline.valueGcEpochs, memline.valueGcEpochsDict, $scopeLine, 500)
            }
        }
    `,
    content: [
        {
            view: 'time-ruler',
            duration: '=samples[].totalValue',
            segments: '=samples[].binCount',
            selectionStart: '=line.samplesMetricsFiltered.rangeStart',
            selectionEnd: '=line.samplesMetricsFiltered.rangeEnd',
            rangeManager: '=line.samplesMetricsFiltered',
            onChange(state, name, el, data, context) {
                // console.log('change', state);
                // const t = Date.now();
                const scopeLine = resolveScopeProfileLine(null, context);
                const samplesMetrics = scopeLine.samplesMetricsFiltered;

                if (state.timeStart !== null) {
                    samplesMetrics.setRange(state.timeStart, state.timeEnd);
                } else {
                    samplesMetrics.resetRange();
                }

                // console.log('compute timings', Date.now() - t);
            },
            details: [
                {
                    view: 'block',
                    className: 'timeline-segment-info',
                    data: 'samples',
                    content: [
                        { view: 'block', content: 'text:`Range: ${#.timeStart.formatMicrosecondsTime(line.axisTotal)} – ${#.timeEnd.formatMicrosecondsTime(line.axisTotal)}`' },
                        { view: 'block', content: ['text:`Duration: `', 'duration:{ time: #.timeEnd - #.timeStart, total: line.axisTotal }'] },
                        { view: 'block', content: 'text:`Samples: ${$[].binSamples[#.segmentStart:#.segmentEnd + 1].sum()}`' }
                    ]
                },
                {
                    view: 'block',
                    className: 'details-sections',
                    content: [
                        {
                            view: 'block',
                            className: 'details-section',
                            content: [
                                {
                                    view: 'block',
                                    className: 'details-section-title',
                                    content: 'text:`${"selfValue".metricName(line)} by category`'
                                },
                                {
                                    view: 'list',
                                    className: 'category-timings-list',
                                    data: 'samples',
                                    itemConfig: {
                                        className: '=bins[#.segmentStart:#.segmentEnd + 1].sum() = 0 ? "no-time"',
                                        postRender: (el, _, data) => el.style.setProperty('--color', data.color),
                                        content: [
                                            'block{ className: "category-name", content: "text:category.name" }',
                                            'metric:{ value: bins[#.segmentStart:#.segmentEnd + 1].sum(), total: #.timeEnd - #.timeStart }'
                                        ]
                                    }
                                }
                            ]
                        },
                        {
                            view: 'block',
                            className: 'details-section',
                            when: 'functionCodes or heap',
                            content: [
                                {
                                    view: 'context',
                                    data: 'functionCodes',
                                    whenData: true,
                                    content: [
                                        {
                                            view: 'block',
                                            className: 'details-section-title',
                                            content: 'text:"Code states"'
                                        },
                                        {
                                            view: 'list',
                                            className: 'category-timings-list with-from',
                                            data: `
                                                $maxTotal: totalBins[#.segmentStart:#.segmentEnd + 1].max();

                                                byTier.({ $bins: bins[#.segmentStart:#.segmentEnd + 1]; ..., value: $bins.max(), from: $bins.min(), $maxTotal }) + {
                                                    $bins: totalBins[#.segmentStart:#.segmentEnd + 1];

                                                    name: "Total",
                                                    value: $bins.max(),
                                                    from: $bins.min(),
                                                    $maxTotal,
                                                    color: totalColor
                                                }
                                            `,
                                            itemConfig: {
                                                className: '=value = 0 ? "no-value"',
                                                postRender: (el, _, data) => el.style.setProperty('--color', data.color),
                                                content: [
                                                    'block{ className: "category-name", content: "text:name" }',
                                                    {
                                                        view: 'block',
                                                        className: 'value-with-from',
                                                        content: [
                                                            { view: 'text-numeric', when: 'from != value and from is number', text: '=`${from} → `' },
                                                            'value-fraction{ value, total: maxTotal }'
                                                        ]
                                                    }
                                                ]
                                            }
                                        }
                                    ]
                                },
                                {
                                    view: 'context',
                                    data: 'heap',
                                    whenData: true,
                                    content: [
                                        {
                                            view: 'block',
                                            className: 'details-section-title',
                                            content: 'text:"Heap size"'
                                        },
                                        {
                                            view: 'list',
                                            className: 'category-timings-list with-from',
                                            data: `[
                                                { $selection: totalHeapSize[#.segmentStart:#.segmentEnd + 1]; name: 'Total size', value: $selection.max(), from: $selection.min(), total: maxTotal },
                                                { name: 'Allocated', value: new[#.segmentStart:#.segmentEnd + 1].sum(), total: newTotal },
                                                { name: 'Released', value: delete[#.segmentStart:#.segmentEnd + 1].sum(), total: deleteTotal }
                                            ]`,
                                            itemConfig: {
                                                className: '=value = 0 ? "no-value"',
                                                postRender: (el, _, data) => el.style.setProperty('--color', data.color),
                                                content: [
                                                    'block{ content: "text:name" }',
                                                    {
                                                        view: 'block',
                                                        className: 'value-with-from',
                                                        content: [
                                                            { view: 'text-numeric', when: 'from is number', text: '=`${from.bytes(false)} … `' },
                                                            'value-fraction{ value: value.bytes(false), fraction: value / total  }'
                                                        ]
                                                    }
                                                ]
                                            }
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                }
            ],
            content: [
                'struct'
            ]
        },
        {
            view: 'list',
            className: 'events-x',
            when: 'scopeLine().type = "timeline"',
            data: `scopeProfile() |
                $start: timeline | axisStart + axisStartNoSamples;
                $total: timeline.axisTotal;
                thread.events.[name in ["MinorGC", "MajorGC"]].({ start: tm - $start, $total, ... })
            `,
            whenData: true,
            limit: false,
            itemConfig: {
                view: 'block',
                className: 'event-x gc-event-x',
                postRender: (el, _, data) => {
                    el.style.setProperty('--start', (100 * data.start / data.total).toFixed(4) + '%');
                    el.style.setProperty('--duration', (100 * data.duration / data.total).toFixed(4) + '%');
                    el.style.setProperty('--color', data.name === 'MinorGC' ? '#f7b26ba0' : '#f78c6ba0');
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
                        view: 'sample-histogram',
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
            when: 'lineMappingControl | size() > 1',
            ...sessionExpandState('default-timelines-line-mapping-control', false, '$'),
            data: 'lineMappingControl',
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
                                    view: 'sample-histogram',
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
        histAllocationSpaces,
        chartUsedHeap,
        userTimingsTimeline
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
                data: [
                    { text: 'Categories', value: 'categories' },
                    { text: 'Packages', value: 'packages', active: true },
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
        tree: '=$[#.dataset + "Tree"]',
        timings: '=scopeLine().tree[#.dataset].filtered',
        lockScrolling: true,
        postRender(el, config, data, context) {
            el.classList.toggle('lock-scrolling', !context.params.flamechartFullpage);
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
        view: 'page-header',
        content: [
            {
                view: 'h2',
                content: [
                    { view: 'block', className: 'logo' },
                    'text:#.datasets[].resource | type = "file" ? name : "Untitled profile"'
                ]
            },
            primaryLineSwitcher
        ]
    },

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
        content: categoriesTimeline
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
