import { timingCols } from './common.js';

discovery.page.define('locations', {
    view: 'context',
    modifiers: [
        {
            view: 'toggle-group',
            name: 'locationsSource',
            whenData: 'scopeLine() | dict.locations and locations',
            value: '="getSessionSetting".callAction("call-frame-source__line-locations", "tree")',
            data: [
                {
                    value: 'tree',
                    text: 'Tree locations'
                },
                {
                    value: 'vector',
                    text: 'Vector locations'
                }
            ]
        }
    ],
    content: {
        view: 'table',
        className: 'locations-table',
        data: 'scopeLine() | (#.locationsSource | $ = "tree" or is undefined) ? dict.locations : locations | filtered.entries.sort(selfValue desc, totalValue desc)',
        postRender(el, _, data, context) {
            if (context.locationsSource) {
                context.actions.setSessionSetting?.('call-frame-source__line-locations', context.locationsSource);
            }
        },
        cols: [
            ...timingCols,
            {
                header: 'Location code',
                content: 'location-source:entry'
            },
            {
                header: '',
                context: '{ ...#, locationLine: entry.callFrame.script.source[entry.callFrame.start:entry.scriptOffset].split(/\\r\\n?|\\n/).size() }',
                data: 'entry.callFrame',
                contentWhen: 'hasSource()',
                details: {
                    view: 'call-frame-source',
                    postRender(el, _, data, context) {
                        const numEl = el.querySelector(`:scope .view-source__lines span:nth-child(${context.locationLine})`);
                        if (numEl) {
                            numEl.classList.add('selected');
                            numEl.parentNode.nextSibling?.style.setProperty('z-index', '1');
                        }
                    }
                }
            },
            {
                details: 'struct'
            },
            {
                header: 'Call frame',
                content: 'call-frame-badge:entry.callFrame'
            }
        ]
    }
});
