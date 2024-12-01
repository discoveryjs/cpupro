export const timingCols = [
    { header: 'Self time',
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
    { header: 'Nested time',
        className: 'timings',
        sorting: 'nestedTime desc, totalTime desc',
        when: 'totalTime',
        contentWhen: 'nestedTime',
        content: 'duration:{ time: nestedTime, total: #.data.totalTime }'
    },
    { header: 'Total time',
        sorting: 'totalTime desc, selfTime desc',
        when: 'totalTime',
        content: 'duration:{ time: totalTime, total: #.data.totalTime }'
    }
];
