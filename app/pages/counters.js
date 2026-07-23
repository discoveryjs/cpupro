discovery.page.define('counters', {
    view: 'context',
    data: 'sessions.processes.threads.counters',
    modifiers: [
        {
            view: 'page-header',
            prelude: [
                {
                    view: 'select',
                    name: 'counterName',
                    data: 'name.sort($ ascN)',
                    value: '#.id or $[0]'
                }
            ],
            content: 'h1:"Counters (prototype)"'
        }
    ],

    content: [
        { view: 'context', postRender(el, config, data, context) {
            discovery.setPageRef(context.counterName);
        } },
        {
            view: 'switch',
            content: [
                { when: 'no $[=>name=#.counterName]', content: [
                    'alert-warning:`No counter with name "${#.counterName}" found`'
                ] },
                { content: [{
                    view: 'context',
                    data: `
                        $counters: .[name=#.counterName];
                        $profileTimelines: $counters.thread.profiles.timeline;
                        $profileMinTm: $profileTimelines.axisStart.min();
                        $profileMaxTm: $profileTimelines.axisEnd.max();
                        $minX: [$profileMinTm, $counters.values.tm.min()].min();
                        $maxX: [$profileMaxTm, $counters.values.tm.max()].max();
                        $maxY: $counters.values.value.max();

                        .[name=#.counterName].({ ..., $minX, $maxX, $maxY })
                    `,
                    content: [
                        // 'struct',
                        'header:"Overall dynamics"',
                        {
                            view: 'cpupro-chart',
                            minX: '=$[].minX',
                            maxX: '=$[].maxX',
                            points: '=values.().combineCounters(=>counter).({ x: tm, y: value })',
                            labelFormat: '==>bytes()',
                            height: 120,
                            color: '#cae97aa0'
                        },
                        'header:"Counter by thread"',
                        {
                            view: 'list',
                            item: [
                                {
                                    view: 'expand',
                                    className: 'trigger-outside',
                                    header: 'text:thread.process.name + " / " + thread.name',
                                    expanded: true,
                                    content: [
                                        {
                                            view: 'cpupro-chart',
                                            minX: '=minX',
                                            maxX: '=maxX',
                                            maxY: '=maxY',
                                            points: '=values.({ x: tm, y: value })',
                                            labelFormat: '==>bytes()',
                                            height: 120,
                                            color: '#e8bc6da0'
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                }] }
            ]
        }
    ]
});
