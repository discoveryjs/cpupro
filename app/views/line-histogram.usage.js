const histogram = {
    view: 'line-histogram',
    extent: { start: 120, end: 180 },
    bins: [0, 0, 1, 3, 2, 4, 0, 2, 0, 0],
    height: 40,
    color: '#e36e5c'
};

export default {
    demo: { ...histogram, viewport: { start: 100, end: 200 } },
    examples: [
        {
            title: 'Bins on the viewport grid',
            highlightProps: ['bins', 'extent', 'viewport'],
            demo: {
                ...histogram,
                extent: { start: 125, end: 155 },
                viewport: { start: 100, end: 200 },
                bins: [0, 0, 1, 3, 2, 1, 0, 0, 0, 0]
            }
        },
        {
            title: 'Common viewport',
            highlightProps: ['extent', 'viewport'],
            demo: { ...histogram, viewport: { start: 100, end: 200 } }
        },
        {
            title: 'Population-local viewport',
            highlightProps: ['viewport'],
            demo: { ...histogram, viewport: { start: 120, end: 180 }, bins: [1, 3, 2, 4, 0, 2, 3, 1] }
        },
        {
            title: 'Viewport from context',
            highlightProps: ['context'],
            demo: { ...histogram, context: '{ ...#, scopeViewport: { start: 100, end: 200 } }' }
        },
        {
            title: 'Bins for a narrower viewport',
            highlightProps: ['viewport'],
            demo: { ...histogram, viewport: { start: 130, end: 160 }, bins: [3, 2, 4, 0, 2] }
        },
        {
            title: 'No population coverage',
            highlightProps: ['viewport'],
            demo: { ...histogram, viewport: { start: 0, end: 100 }, bins: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }
        }
    ]
};
