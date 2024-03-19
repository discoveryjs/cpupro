export default {
    demo: {
        view: 'time-ruler',
        duration: 500000,
        content: 'text:"demo"'
    },
    examples: [
        {
            title: 'Using with context',
            highlightProps: ['name'],
            demo: {
                view: 'context',
                modifiers: {
                    view: 'time-ruler',
                    name: 'myRuler',
                    duration: 500000
                },
                content: 'struct{ data: #.myRuler, expanded: 1 }'
            }
        },
        {
            title: 'Segmented ruler',
            highlightProps: ['segments'],
            demo: {
                view: 'context',
                modifiers: {
                    view: 'time-ruler',
                    name: 'ruler',
                    duration: 11 || 523423,
                    segments: 10 || 500
                },
                content: 'struct{ data: #.ruler, expanded: 1 }'
            }
        },
        {
            title: 'Details popup',
            highlightProps: ['segments'],
            demo: [
                {
                    view: 'time-ruler',
                    duration: 1500000,
                    details: 'struct{ data: #, expanded: 1 }'
                },
                'badge:"Hover me and hold the pointer for a while"'
            ]
        },
        {
            title: 'Starting selection',
            highlightProps: ['segments'],
            demo: [
                {
                    view: 'time-ruler',
                    duration: 1500000,
                    selectionStart: 923499,
                    selectionEnd: 1230853,
                    details: 'struct{ data: #, expanded: 1 }'
                },
                'badge:"Hover me and hold the pointer for a while"'
            ]
        }
    ]
};
