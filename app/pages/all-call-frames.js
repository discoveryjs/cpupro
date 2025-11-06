import { fixDetailsScroll, primaryLineSwitcher } from './common.js';

const experimentalFeatures = false;
const table = {
    view: 'table',
    className: 'all-page-table',
    limit: 100,
    data: 'sort(selfValue desc, totalValue desc)',
    postRender(el) {
        fixDetailsScroll(el);
    },
    cols: [
        { header: { className: 'timings', text: '="selfValue".metricName()' },
            className: 'timings',
            sorting: 'selfValue desc, totalValue desc',
            colSpan: '=totalValue ? 1 : 3',
            contentWhen: 'selfValue or no totalValue',
            content: {
                view: 'switch',
                content: [
                    { when: 'totalValue', content: 'metric:selfValue' },
                    { content: 'no-samples' }
                ]
            }
        },
        { header: { className: 'timings', text: '="nestedValue".metricName()' },
            className: 'timings',
            sorting: 'nestedValue desc, totalValue desc',
            when: 'totalValue',
            contentWhen: 'nestedValue',
            content: 'metric:nestedValue'
        },
        { header: { className: 'timings', text: '="totalValue".metricName()' },
            className: 'timings',
            sorting: 'totalValue desc, selfValue desc',
            when: 'totalValue',
            content: 'metric:totalValue'
        },

        // hotness
        { header: '', colWhen: '$[=>right]',
            sorting: 'right.hotness | $ = "hot" ? 3 : $ = "warm" ? 2 : $ = "cold" ? 1 : 0 desc',
            data: 'right',
            contentWhen: 'hotness = "hot" or hotness = "warm"',
            content: 'code-hotness-icon:topTier'
        },

        // call frame identity
        { header: 'Kind',
            content: 'call-frame-kind-badge:entry.kind'
        },
        { header: 'Call frame',
            sorting: 'name ascN',
            content: {
                view: 'badge',
                data: 'entry.marker() | { text: title, href, match: #.filter }',
                content: 'text-match'
            }
        },

        // source and codes
        { header: 'Source', colWhen: '$[=>entry.hasSource()]',
            sorting: '(entry | regexp ? regexp.size() : start >= 0 ? end - start : -1) desc',
            data: 'entry',
            align: 'right',
            content: 'text-with-unit{ value: regexp ? regexp.size() : end - start |? $ > 999 ? kb() : $ + "b" : "", unit: true }',
            detailsWhen: 'hasSource()',
            details: {
                view: 'call-frame-source'
                // context: '{ ...#, nonFilteredTimings: true }'
            }
        },
        { header: 'Codes', colWhen: '$[=>right.codes]',
            sorting: '(right | topTierWeight * 1000 + codes.size()) desc',
            data: 'right',
            content: {
                view: 'inline-list',
                className: 'code-tier-list',
                when: 'codes',
                data: 'codes.group(=>tier).({ tier: key, count: value.size() })',
                itemConfig: {
                    view: 'code-tier-badge',
                    tier: '=tier',
                    count: '=count | $ > 1?'
                }
            },
            detailsWhen: 'codes',
            details: {
                view: 'call-frame-codes-table',
                data: 'codes',
                tablePostRender(el) {
                    fixDetailsScroll(el);
                }
            }
        },
        { header: 'Deopt', colWhen: '$[=>right.codes.deopt]',
            sorting: 'right.codes.deopt.size() desc',
            data: 'right.codes.deopt.size()',
            contentWhen: '$'
        },

        // secondary
        { header: 'Module',
            sorting: 'moduleName ascN, loc ascN',
            data: 'entry',
            content: [
                'module-badge:module',
                'call-frame-loc-badge'
            ]
        },

        // source & tiers
        { header: 'Tiers', colWhen: experimentalFeatures && '$[=>right]',
            sorting: 'right.codes.size() desc',
            data: 'right',
            content: {
                view: 'inline-list',
                data: 'codes.([[tier.abbr() + "\xa0"]])',
                whenData: true
            }
        }
    ]
};

const summary = {
    view: 'block',
    className: 'app-page-summary',
    content: [
        { view: 'block', content: ['text:"Call frames:"', 'text-numeric:size()'] },
        { view: 'block', content: ['text:`${"totalValue".metricName()}:`', 'metric:sum(=>selfValue)'] }
    ]
};

discovery.page.define('call-frames', [
    {
        view: 'context',
        context: '{ ...#, scopeProfile: #.primaryProfile }',
        data: `
            scopeLine() | dict.callFrames.all.entries
                .zip(=> entry, profile.codesByCallFrame, => callFrame)
                .({
                    $entry: left.entry;

                    ...,
                    $entry,
                    name: $entry.name,
                    moduleName: $entry.module.name,
                    loc: $entry.loc
                })
        `,
        modifiers: [
            {
                view: 'page-header',
                className: 'all-page-header',
                prelude: [
                    'badge{ text: "Packages", className: #.page = "packages" ? "selected", href: #.page != "packages" ? "#packages" }',
                    'badge{ text: "Modules", className: #.page = "modules" ? "selected", href: #.page != "modules" ? "#modules" }',
                    'badge{ text: "Call frames", className: #.page = "call-frames" ? "selected", href: #.page != "call-frames" ? "#call-frames" }',
                    {
                        view: 'context',
                        content: primaryLineSwitcher
                    }
                ],
                content: [
                    'h1:"All call frames"',
                    {
                        view: 'input',
                        name: 'filter',
                        type: 'regexp',
                        placeholder: 'Filter'
                    }
                ]
            }
        ],
        content: {
            view: 'context',
            data: '.[name ~= #.filter]',
            content: {
                view: 'update-on-line-metrics-changes',
                metrics: '=scopeLine().dict.callFrames.filtered',
                content: {
                    view: 'context',
                    data: `.({
                        ...,
                        selfValue: left.selfValue,
                        nestedValue: left.nestedValue,
                        totalValue: left.totalValue
                    })`,
                    content: [
                        table,
                        summary
                    ]
                }
            }
        }
    }
]);
