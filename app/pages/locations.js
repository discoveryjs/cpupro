import { timingCols } from './common.js';

discovery.page.define('locations', {
    view: 'context',
    context: '{ ...#, currentProfile }',
    data: 'currentProfile.callFramePositionsTimingsFiltered.entries.sort(selfTime desc, totalTime desc)',
    modifiers: [
    ],
    content: {
        view: 'table',
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
