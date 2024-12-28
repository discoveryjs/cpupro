export const timingCols = [
    {
        header: 'Self time',
        className: 'timings self-time',
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
    {
        header: 'Nested time',
        className: 'timings',
        sorting: 'nestedTime desc, totalTime desc',
        when: 'totalTime',
        contentWhen: 'nestedTime',
        content: 'duration:{ time: nestedTime, total: #.data.totalTime }'
    },
    {
        header: 'Total time',
        className: 'timings',
        sorting: 'totalTime desc, selfTime desc',
        when: 'totalTime',
        content: 'duration:{ time: totalTime, total: #.data.totalTime }'
    }
];

export const callFramesCol = (data, moduleCol = false) => ({
    header: 'Call frames',
    className: 'number sampled-numbers',
    data,
    content: 'sampled-count-total{ hideZeroCount: true, count(=> totalTime?), total: size() }',
    details: [
        {
            view: 'table',
            cols: [
                ...timingCols,
                ...moduleCol ? [{
                    header: 'Module',
                    className: 'subject-name',
                    sorting: 'entry.module.name ascN',
                    content: 'module-badge:entry'
                }] : [],
                {
                    header: 'Call frame',
                    className: 'subject-name',
                    sorting: 'entry.name ascN, entry.module.name ascN',
                    content: 'badge:entry.marker() | { text: title, href }'
                }
            ]
        }
    ]
});
