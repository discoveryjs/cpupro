import { allPageHeader, allPageTable, allPageSummary } from './all-page-common.js';
import { valueCols } from './common.js';

discovery.page.define('locations', [
    {
        view: 'context',
        context: '{ ...#, scopeProfile: #.primaryProfile }',
        data: 'scopeBreakdown() | locations or callFrames | filtered.dict.entries.sort(selfValue desc, totalValue desc)',
        modifiers: [
            allPageHeader([
                'h1:"All locations"'
            ])
        ],
        content: {
            view: 'context',
            content: [
                allPageTable({
                    limit: 50,
                    cols: [
                        ...valueCols,
                        {
                            header: 'Call frame',
                            content: 'call-frame-badge:entry.callFrame'
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
                            header: 'Location in source',
                            content: 'location-source:entry'
                        }
                    ]
                }),

                allPageSummary('text:"Locations:"')
            ]
        }
    }
]);
