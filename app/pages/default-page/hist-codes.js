import { sessionExpandState } from '../common.js';
import { withLineWindowValue, lineWindowHistogram } from '../../views/misc/line-window.js';

// Code states are binned for the line window, the values derived from them follow it. Tier rows are the tiers
// of the codes and their shares are of all functions by their top tier, so they don't depend on the window
export const histCodes = withLineWindowValue('codeBins', `
    scopeProfile() | codes |? {
        $codes: sort(tm asc);
        $totalBins: $codes.binScriptFunctionCodesTotal(#.binCount);

        compilationBins: $codes.binScriptFunctionCodes(#.binCount),
        totalBins: $totalBins.fnCount,
        maxTotal: $totalBins.fnCount.max(),
        byTier: $totalBins.byTier.({ name: $[0], bins: $[1] })
    }
`, {
    view: 'expand',
    when: '#.primaryLineType != "memline"',
    ...sessionExpandState('default-code-tiers', false, '$'),
    data: `
        $profile: scopeProfile();
        $profile | codes |? {
            $countByTopTier: $profile.codesByCallFrame.group(=> topTier).({ tier: key, count: value.size() });
            $codes: sort(tm asc);
            $tiers: $codes.tier;

            $countByTopTier,
            functionCount: $profile.codesByCallFrame.size(),
            extent: $profile.timeline.timestampExtent($codes[-1].tm),
            compilations: $codes,
            totalColor: '#7fb2f7a0',
            codesTotalColor: "compilation".color(),
            byTier: #.codeBins.value.byTier.name.[$ in $tiers].({
                $tier: $;

                name: $tier,
                color: $tier.color(),
                maxTier: $countByTopTier[=> tier = $tier].count or 0
            })
        }
    `,
    className: '=no $ ? "unavailable"',
    header: [
        {
            view: 'block',
            className: 'expand-label',
            content: 'text:"Code states"'
        },
        histFunctionCodesHeader()
    ],
    rulerDetails: {
        view: 'block',
        className: 'details-section',
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
                    $window: #.codeBins.value;
                    $maxTotal: $window.totalBins[#.binStart:#.binEnd].max();

                    byTier.({
                        $tier: name;
                        $bins: $window.byTier[=> name = $tier].bins[#.binStart:#.binEnd];

                        ...,
                        value: $bins.max(),
                        from: $bins.min(),
                        $maxTotal
                    }) + {
                        $bins: $window.totalBins[#.binStart:#.binEnd];

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
    content: {
        view: 'switch',
        content: [
            { when: '$', content: histFunctionCodesBody() },
            { content: {
                view: 'block',
                className: 'data-unavailable',
                content: 'md:"The profile does not contain the necessary data. Use [V8 log](https://v8.dev/docs/profile) (raw or [preprocessed](https://v8.dev/docs/profile#web-ui-for---prof)) to enable the feature."'
            } }
        ]
    }
});

function histFunctionCodesHeader() {
    return {
        view: 'switch',
        content: [
            { when: 'no $', content: 'html:` <span style=\"color: #888\">(unavailable)</span>`' },
            { content: [
                { view: 'block', className: 'labeled-value-groups', content: [
                    { view: 'block', className: 'labeled-value-group', content: [
                        {
                            view: 'labeled-value',
                            color: '=codesTotalColor',
                            text: 'Codes',
                            value: 'text-numeric:compilations.size()'
                        },
                        {
                            view: 'labeled-value',
                            color: '=totalColor',
                            text: 'Functions',
                            value: 'text-numeric:compilations.callFrame.size()'
                        }
                    ] },
                    {
                        view: 'inline-list',
                        className: 'labeled-value-group',
                        data: 'byTier.({ ..., functionCount: @.functionCount })',
                        itemConfig: {
                            view: 'labeled-value',
                            color: '=color',
                            text: '=name',
                            value: 'text:100 * maxTier / functionCount | `${toFixed(2)}%`'
                        }
                    }
                ] }
            ] }
        ]
    };
}

function histFunctionCodesBody() {
    return [
        {
            view: 'link',
            className: 'category-timelines-item',
            content: [
                {
                    view: 'block',
                    className: 'label',
                    postRender: (el, _, data) => el.style.setProperty('--color', data.codesTotalColor),
                    content: 'text:"Codes"'
                },
                {
                    view: 'block',
                    className: 'total-value',
                    content: 'text-numeric:compilations.size()'
                },
                lineWindowHistogram('codeBins', '{ extent, bins: #.codeBins.value.compilationBins }', {
                    extent: '=extent',
                    bins: '=bins',
                    color: '="compilation".color()'
                })
            ]
        },
        {
            view: 'link',
            className: 'category-timelines-item',
            content: [
                {
                    view: 'block',
                    className: 'label',
                    postRender: (el, _, data) => el.style.setProperty('--color', data.totalColor),
                    content: 'text:"Functions"'
                },
                {
                    view: 'block',
                    className: 'total-value',
                    content: 'text-numeric:compilations.callFrame.size()'
                },
                lineWindowHistogram('codeBins', '{ extent, bins: #.codeBins.value.totalBins, totalColor }', {
                    extent: '=extent',
                    bins: '=bins',
                    color: '=totalColor'
                })
            ]
        },
        {
            view: 'list',
            className: 'category-timelines-list',
            data: 'byTier.({ ..., extent: @.extent, functionCount: @.functionCount })',
            item: {
                view: 'link',
                className: 'category-timelines-item',
                content: [
                    {
                        view: 'block',
                        className: 'label',
                        postRender: (el, _, data) => el.style.setProperty('--color', data.color),
                        content: 'text:name'
                    },
                    {
                        view: 'block',
                        className: 'total-percent',
                        content: 'text:100 * maxTier / functionCount | toFixed(2)'
                    },
                    lineWindowHistogram('codeBins', `
                        $tier: name;
                        $window: #.codeBins.value;
                        { ..., bins: $window.byTier[=> name = $tier].bins, maxTotal: $window.maxTotal }
                    `, {
                        extent: '=extent',
                        bins: '=bins',
                        max: '=maxTotal',
                        binsMax: true,
                        color: '=color'
                    })
                ]
            }
        }
    ];
}
