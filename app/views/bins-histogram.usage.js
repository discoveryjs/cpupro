const range = { start: 0, end: 1000 };
const bins = [0, 1, 3, 2, 5, 8, 6, 3, 1, 0, 0, 2, 4, 3, 1, 0];
// Two thousand bins merge into columns by four on a wide canvas and split while zooming in
const fineBins = Array.from({ length: 2000 }, (_, index) =>
    Math.round(10 * (1 + Math.sin(index / 40)) * (1 + Math.sin(index / 7)) * (index % 97 < 60 ? 1 : 0.2))
);

function zoomDemo() {
    const histograms = new Set();

    return [
        {
            view: 'block',
            className: 'view-bins-histogram-zoom-demo',
            content: {
                view: 'ruler',
                range,
                bounds: range,
                onRangeChange(api) {
                    for (const histogram of histograms) {
                        histogram.setViewport(api.state.range);
                    }
                }
            }
        },
        ...['#e36e5c', '#65b4fd'].map((color, index) => ({
            view: 'bins-histogram',
            bins: index ? fineBins.map(value => 30 - value % 31) : fineBins,
            range,
            height: 40,
            color,
            onInit(api) {
                histograms.add(api);

                return () => histograms.delete(api);
            }
        })),
        'badge:"Zoom with a pinch or Ctrl/Cmd + wheel over the ruler, pan with a horizontal wheel"'
    ];
}

export default {
    demo: { view: 'bins-histogram', bins, height: 40, color: '#e36e5c' },
    examples: [
        {
            title: 'Shared maximum',
            highlightProps: ['max', 'binsMax'],
            demo: { view: 'bins-histogram', bins, max: 16, binsMax: true, height: 40 }
        },
        {
            title: 'Presence of bins with small values',
            highlightProps: ['presence'],
            demo: { view: 'bins-histogram', bins, presence: bins.map((_, index) => index === 9 ? 1 : 0), height: 40 }
        },
        {
            title: 'Scales',
            highlightProps: ['scale'],
            demo: ['linear', 'sqrt', 'log'].map(scale => ({ view: 'bins-histogram', bins: [1, 4, 16, 64, 256], scale, height: 30 }))
        },
        {
            title: 'Merged columns',
            highlightProps: ['bins'],
            demo: { view: 'bins-histogram', bins: fineBins, height: 40 }
        },
        {
            title: 'Peaks of a level',
            highlightProps: ['peaks'],
            demo: [false, true].map(peaks => ({ view: 'bins-histogram', bins: fineBins, peaks, height: 40 }))
        },
        {
            title: 'Viewport within the range of bins',
            highlightProps: ['range', 'viewport'],
            demo: { view: 'bins-histogram', bins: fineBins, range, viewport: { start: 400, end: 500 }, height: 40 }
        },
        {
            title: 'Zoom',
            highlightProps: ['onInit'],
            demo: zoomDemo()
        }
    ]
};
