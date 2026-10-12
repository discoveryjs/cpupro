import { allPageHeader } from './all-page-common.js';
import { signalWindows, signalMeasurements, compilationPopulation, signalScopes, signalScopeLabel } from '../signals.js';
import { correlations } from './signals-page/correlations.js';
import { samplePopulation } from './signals-page/populations.js';

function number(data, header) {
    return {
        header,
        align: 'right',
        content: { view: 'text-numeric', when: `${data} is number`, data }
    };
}

const signalDetails = {
    view: 'context',
    context: '{ ...#, scopeProfile: $ }',
    content: {
        view: 'tabs', name: 'signalTab',
        tabs: `=[
            timeline ? { value: 'cpu', text: 'CPU samples' },
            memline ? { value: 'allocations', text: 'Allocations' },
            thread.compilations ? { value: 'events', text: 'Compilation events' },
            { value: 'overview', text: 'Overview' }
        ].[$]`,
        content: {
            view: 'switch',
            content: [
                {
                    when: '#.signalTab = "cpu"',
                    content: [
                        samplePopulation('timeline'),
                        {
                            view: 'expand', when: 'thread.compilations',
                            header: 'text:"CPU sample coverage by compilation events"',
                            content: correlations('timeline')
                        }
                    ]
                },
                {
                    when: '#.signalTab = "allocations"',
                    content: [
                        samplePopulation('memline'),
                        {
                            view: 'expand', when: 'memline.attributes.[name = "allocationCompilationStage"]',
                            header: 'text:"Allocation coverage by recorded compilation stage"',
                            content: correlations('memline')
                        }
                    ]
                },
                {
                    when: '#.signalTab = "events"',
                    content: {
                        view: 'section',
                        header: 'text:"Compilation events"',
                        content: {
                            view: 'table', data: compilationPopulation, limit: 20,
                            cols: [
                                { header: 'Event', content: 'text:name' },
                                number('count', 'Count'),
                                number('timed', 'Timed'),
                                number('instant', 'Instant'),
                                number('unfinished', 'Missing time / duration'),
                                number('duration', 'Inclusive duration sum (us)'),
                                number('maxDuration', 'Max duration (us)'),
                                number('first', 'First timestamp (us)'),
                                number('last', 'Last end (us)')
                            ]
                        }
                    }
                },
                { content: [
                    {
                        view: 'section',
                        header: 'text:"Recorded populations"',
                        content: {
                            view: 'table',
                            data: signalWindows,
                            cols: [
                                { header: 'Signal', content: 'text:title' },
                                {
                                    header: 'Count', align: 'right',
                                    content: {
                                        view: 'switch',
                                        content: [
                                            { when: 'count > 0', content: 'text-numeric:count' },
                                            { content: 'text:"No records"' }
                                        ]
                                    }
                                },
                                number('time.start', 'Time start (us)'),
                                number('time.end', 'Time end (us)'),
                                number('ids.start', 'Allocation id start'),
                                number('ids.end', 'Allocation id end')
                            ]
                        }
                    },
                    {
                        view: 'text', when: 'no timeline and no memline and no thread.compilations',
                        data: '"No CPU samples, allocations or compilation events in this scope"'
                    },
                    {
                        view: 'section', when: 'timeline and memline',
                        header: 'text:"CPU / allocation recording boundaries"',
                        content: {
                            view: 'context',
                            context: '{ ...#, allocationCount: memline.values.size() }',
                            data: 'allocationSampleWindow()',
                            content: {
                                view: 'switch', content: [
                                    {
                                        when: '$',
                                        content: {
                                            view: 'table',
                                            data: `[
                                    { text: 'Before CPU', value: start },
                                    { text: 'Within CPU', value: end - start },
                                    { text: 'After CPU', value: #.allocationCount - end }
                                ]`,
                                            cols: [
                                                { header: 'Window (assuming allocation IDs 1..N)', content: 'text:text' },
                                                { header: 'Allocations', content: 'value-fraction{ value, total: #.allocationCount }' }
                                            ]
                                        }
                                    },
                                    { content: 'text:"Allocation IDs cannot be treated as consecutive sample indices; boundary counts are unknown"' }
                                ]
                            }
                        }
                    },
                    {
                        view: 'expand', when: signalMeasurements.map(({ when }) => `(${when})`).join(' or '),
                        header: 'text:"Measurements and boundaries"',
                        content: signalMeasurements.map(({ title, definition, unit, when, data }) => ({
                            view: 'context', when, data,
                            content: {
                                view: 'block', className: 'signal-measurement',
                                content: [
                                    {
                                        view: 'text', data: () => title + (unit ? ` (${unit})` : ''),
                                        tooltip: {
                                            showDelay: true, className: 'cpupro-hint-tooltip',
                                            content: { view: 'md', source: definition }
                                        }
                                    },
                                    {
                                        view: 'switch', content: [
                                            { when: 'value is not number', content: 'text:"Unknown"' },
                                            { when: 'of > 0', content: 'value-fraction{ value, total: of }' },
                                            { content: 'text-numeric:value' }
                                        ]
                                    },
                                    {
                                        view: 'block', when: 'of is number',
                                        content: ['text:"of "', 'text-numeric:of']
                                    }
                                ]
                            }
                        }))
                    }
                ] }
            ]
        }
    }
};

discovery.page.define('signals', {
    view: 'context',
    data: signalScopes,
    modifiers: allPageHeader([
        'h1:"Signals"',
        {
            view: 'block', className: 'signal-thread',
            content: [
                {
                    view: 'select', when: 'size() > 1', name: 'signalScope',
                    value: '$[=>$ = #.primaryProfile] or $[0]',
                    text: signalScopeLabel
                },
                { view: 'text', when: 'size() = 1', data: `$[0] | ${signalScopeLabel}` }
            ]
        }
    ]),
    content: {
        view: 'context',
        data: '#.signalScope ?? $[=>$ = #.primaryProfile] ?? $[0]',
        content: signalDetails
    }
});
