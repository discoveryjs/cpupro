export default {
    demo: {
        view: 'ruler',
        range: [-1, 1],
        details: 'struct: #.detail'
    },
    examples: [
        {
            title: 'Custom labels',
            highlightProps: ['formatLabel'],
            demo: {
                view: 'ruler',
                range: 100,
                formatLabel: value => `${value}%`
            }
        },
        {
            title: 'Continuous selection',
            highlightProps: ['range', 'selection'],
            demo: {
                view: 'ruler',
                range: { start: 100, end: 200 },
                selection: { start: 123.5, end: 156.25 },
                details: 'struct: #.detail'
            }
        },
        {
            title: 'Segmented ruler',
            highlightProps: ['segments'],
            demo: {
                view: 'ruler',
                range: [0, 1],
                segments: 10,
                details: 'struct: #.detail'
            }
        },
        {
            title: 'Explicit segment boundaries',
            highlightProps: ['segments'],
            demo: { view: 'ruler', range: [100, 200], segments: [100, 110, 140, 200], details: 'struct: #.detail' }
        },
        {
            title: 'Without grid or labels',
            highlightProps: ['grid', 'labels'],
            demo: { view: 'ruler', range: 100, grid: false, labels: false, selection: { start: 20, end: 60 } }
        },
        {
            title: 'Details popup',
            highlightProps: ['segments'],
            demo: [
                {
                    view: 'ruler',
                    range: 1500000,
                    segments: 10,
                    details: 'struct{ data: { ruler: #.ruler, detail: #.detail }, expanded: 1 }'
                },
                'badge:"Hover me and hold the pointer for a while"'
            ]
        },
        {
            title: 'Multiple selection',
            highlightProps: ['multiple', 'selection'],
            demo: [
                {
                    view: 'ruler',
                    range: 1500000,
                    multiple: true,
                    selection: [{ start: 100000, end: 300000 }, { start: 923499, end: 1230853 }],
                    details: 'struct{ data: { ruler: #.ruler, detail: #.detail }, expanded: 1 }'
                },
                'badge:"Hover me and hold the pointer for a while"'
            ]
        }
    ]
};
