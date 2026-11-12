// Histograms show bins computed for a window of the line viewport (`line.window`), so zooming and panning within it
// only change their display. Values computed for the window are evaluated again on the first read after the window
// population changes, once for all of their readers, and views showing them follow without rendering a whole
// section again: its rows, lists and their state stay.

// Provides the window as `#.lineWindow`, its value is the context of the window: its range and number of bins
export function withLineWindow(config) {
    return {
        view: 'line-metrics-value',
        name: 'lineWindow',
        metrics: '=scopeBreakdown().populationWindow',
        value: `
            $window: scopeLine().lineWindow();
            { ...#, scopeViewport: $window, binCount: 2000.binCount($window) }
        `,
        ...config
    };
}

// Provides a value computed for the window as `#.<name>`
export function withLineWindowValue(name, value, content) {
    return {
        view: 'line-metrics-value',
        name,
        metrics: '=#.lineWindow',
        valueContext: '#.lineWindow.value',
        value,
        content
    };
}

// A histogram of bins from a value computed for the window, the only part rendered again when it changes
export function lineWindowHistogram(valueName, data, config) {
    return {
        view: 'update-on-line-metrics-changes',
        metrics: `=#.${valueName}`,
        content: {
            view: 'line-histogram',
            zoom: true,
            data,
            viewport: '=#.lineWindow.value.scopeViewport',
            ...config
        }
    };
}
