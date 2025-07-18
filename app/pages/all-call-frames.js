import { fixDetailsScroll } from './common.js';

const experimentalFeatures = false;
const table = {
    view: 'table',
    className: 'all-page-table',
    limit: 100,
    data: 'sort(selfTime desc, totalTime desc)',
    postRender(el) {
        fixDetailsScroll(el);
    },
    cols: [
        { header: { className: 'timings', text: 'Self time' },
            className: 'timings',
            sorting: 'selfTime desc, totalTime desc',
            colSpan: '=totalTime ? 1 : 3',
            contentWhen: 'selfTime or no totalTime',
            content: {
                view: 'switch',
                content: [
                    { when: 'totalTime', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                    { content: 'no-samples' }
                ]
            }
        },
        { header: { className: 'timings', text: 'Nested time' },
            className: 'timings',
            sorting: 'nestedTime desc, totalTime desc',
            when: 'totalTime',
            contentWhen: 'nestedTime',
            content: 'duration:{ time: nestedTime, total: #.data.totalTime }'
        },
        { header: { className: 'timings', text: 'Total time' },
            className: 'timings',
            sorting: 'totalTime desc, selfTime desc',
            when: 'totalTime',
            content: 'duration:{ time: totalTime, total: #.data.totalTime }'
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
        { view: 'block', content: ['text:"Total time:"', 'duration:{ time: sum(=>selfTime), total: #.data.totalTime }'] }
    ]
};

discovery.page.define('call-frames', [
    {
        view: 'context',
        context: '{ ...#, currentProfile }',
        data: `
            #.currentProfile
            | callFramesTimingsFiltered.entries.zip(=> entry, codesByCallFrame, => callFrame)
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
                    'badge{ text: "Call frames", className: #.page = "call-frames" ? "selected", href: #.page != "call-frames" ? "#call-frames" }'
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
                view: 'update-on-timings-change',
                timings: '=#.currentProfile.callFramesTimingsFiltered',
                content: {
                    view: 'context',
                    data: `.({
                        ...,
                        selfTime: left.selfTime,
                        nestedTime: left.nestedTime,
                        totalTime: left.totalTime
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
