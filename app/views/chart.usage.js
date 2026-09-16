const chart = {
    view: 'cpupro-chart',
    minX: 100,
    maxX: 200,
    extent: { start: 110, end: 190 },
    points: [{ x: 120, y: 10 }, { x: 150, y: 20 }, { x: 180, y: 15 }],
    pointsTotal: [{ x: 120, y: 25 }, { x: 180, y: 30 }],
    height: 120,
    color: '#e8bc6da0'
};

export default {
    demo: chart,
    examples: [
        { title: 'Recording coverage within viewport', highlightProps: ['extent'], demo: chart },
        { title: 'Viewport within recording', highlightProps: ['minX', 'maxX'], demo: { ...chart, minX: 130, maxX: 170 } },
        { title: 'Viewport after recording', highlightProps: ['minX', 'maxX'], demo: { ...chart, minX: 200, maxX: 300 } }
    ]
};
