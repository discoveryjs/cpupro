import { resolveScopeProfileLine } from '../../jora/profile.js';
import { sessionExpandState } from '../common.js';

export const hierarchicalComponentsTables = {
    view: 'expand',
    ...sessionExpandState('default-hierarchical-components', true),
    className: 'hierarchical-components trigger-outside',
    postRender: (el, config, data, context) =>
        el.style.setProperty('--total-value-digits',
            String(resolveScopeProfileLine(null, context).axisTotal).replace(/\D/g, '').length - 2
        ),
    header: [
        { view: 'block', content: [
            'text:"Packages "',
            {
                view: 'update-on-line-metrics-changes',
                data: 'scopeBreakdown().packages.filtered.dict',
                content: 'text-numeric:entries.[totalValue].size()'
            },
            { view: 'text-numeric', className: 'total-number', data: '` ⁄ ${packages.size()}`' },
            { view: 'badge', href: '#packages', text: 'all packages →' }
        ] },
        { view: 'block', content: [
            'text:"Modules "',
            {
                view: 'update-on-line-metrics-changes',
                data: 'scopeBreakdown().modules.filtered.dict',
                content: 'text-numeric:entries.[totalValue].size()'
            },
            { view: 'text-numeric', className: 'total-number', data: '` ⁄ ${modules.size()}`' },
            { view: 'badge', href: '#modules', text: 'all modules →' }
        ] },
        { view: 'block', content: [
            'text:"Call frames "',
            {
                view: 'update-on-line-metrics-changes',
                data: 'scopeBreakdown().callFrames.filtered.dict',
                content: 'text-numeric:entries.[totalValue].size()'
            },
            { view: 'text-numeric', className: 'total-number', data: '` ⁄ ${callFrames.size()}`' },
            { view: 'badge', href: '#call-frames', text: 'all call frames →' }
        ] }
    ],
    content: [
        createPackagesList(),
        createModulesList(),
        createCallFrameList()
    ]
};

function createPackagesList() {
    return {
        view: 'section',
        data: 'scopeBreakdown().packages.filtered.dict',
        header: [],
        content: {
            view: 'content-filter',
            content: {
                view: 'update-on-line-metrics-changes',
                debounce: true,
                content: {
                    view: 'table',
                    data: 'entries.[totalValue and entry.name ~= #.filter].sort(selfValue desc, totalValue desc)',
                    limit: 15,
                    cols: [
                        {
                            header: '="selfValue".metricName()',
                            sorting: 'selfValue desc, totalValue desc',
                            content: 'metric:selfValue'
                        },
                        {
                            header: '="totalValue".metricName()',
                            sorting: 'totalValue desc, selfValue desc',
                            content: 'metric:totalValue'
                        },
                        {
                            header: 'Package',
                            className: 'main',
                            sorting: 'entry.name asc',
                            content: 'package-badge:entry'
                        }
                    ]
                }
            }
        }
    };
}

function createModulesList() {
    return {
        view: 'section',
        data: 'scopeBreakdown().modules.filtered.dict',
        header: [],
        content: {
            view: 'content-filter',
            content: {
                view: 'update-on-line-metrics-changes',
                debounce: true,
                content: {
                    view: 'table',
                    data: `entries
                        .[totalValue and entry.name ~= #.filter]
                        .sort(selfValue desc, totalValue desc)
                    `,
                    limit: 15,
                    cols: [
                        {
                            header: '="selfValue".metricName()',
                            sorting: 'selfValue desc, totalValue desc',
                            content: 'metric:selfValue'
                        },
                        {
                            header: '="totalValue".metricName()',
                            sorting: 'totalValue desc, selfValue desc',
                            content: 'metric:totalValue'
                        },
                        {
                            header: 'Module',
                            className: 'main',
                            sorting: 'entry.name ascN',
                            content: 'module-badge:entry'
                        }
                    ]
                }
            }
        }
    };
}

function createCallFrameList() {
    return {
        view: 'section',
        data: `scopeBreakdown() | callFrames.filtered.dict.entries.zip(
            => entry,
            line.profile.codesByCallFrame,
            => callFrame
        )`,
        header: [],
        content: {
            view: 'content-filter',
            content: {
                view: 'update-on-line-metrics-changes',
                metrics: '=scopeBreakdown().callFrames.filtered.dict',
                debounce: true,
                content: {
                    view: 'table',
                    data: `
                        .[left | totalValue and entry.name ~= #.filter]
                        .sort(left.selfValue desc, left.totalValue desc)
                    `,
                    limit: 15,
                    cols: [
                        {
                            header: '="selfValue".metricName()',
                            sorting: 'left.selfValue desc, left.totalValue desc',
                            content: 'metric:left.selfValue'
                        },
                        {
                            header: '="totalValue".metricName()',
                            sorting: 'left.totalValue desc, left.selfValue desc',
                            content: 'metric:left.totalValue'
                        },
                        {
                            header: '',
                            colWhen: '$[=>right]',
                            sorting: 'right.hotness | $ = "hot" ? 3 : $ = "warm" ? 2 : $ = "cold" ? 1 : 0 desc',
                            data: 'right',
                            contentWhen: 'hotness = "hot" or hotness = "warm"',
                            content: 'code-hotness-icon:topTier'
                        },
                        {
                            header: 'Call frame',
                            className: 'main',
                            sorting: 'left.entry.name ascN',
                            content: 'call-frame-badge:left.entry'
                        }
                    ]
                }
            }
        }
    };
}
