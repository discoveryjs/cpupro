import { timingCols } from './common.js';

discovery.page.define('locations', {
    view: 'context',
    content: {
        view: 'table',
        className: 'locations-table',
        data: 'scopeTree() | locations or callFrames | filtered.dict.entries.sort(selfValue desc, totalValue desc)',
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
                header: 'Call frame',
                content: 'call-frame-badge:entry.callFrame'
            }
        ]
    }
});
