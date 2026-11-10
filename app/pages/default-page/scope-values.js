// Values of the line viewport, the population scope of the page: labels and totals of sections follow it rather than
// the zoom or the window of histogram data. A value is computed once per change for all of its readers, which follow
// it without rendering a section again; the viewport changes continuously while it's dragged, so readers are debounced
export function withScopeValue(name, metrics, value, content, valueContext) {
    return {
        view: 'line-metrics-value',
        name,
        metrics,
        value,
        valueContext,
        content
    };
}

// Context of a value binned over the line viewport
export const scopeBinsContext = `
    $scope: scopeLine().lineViewport(#.data.profiles);
    { ...#, scopeViewport: $scope, binCount: 2000.binCount($scope) }
`;

// Content following a scope value
export function scopeValueContent(name, content) {
    return {
        view: 'update-on-line-metrics-changes',
        metrics: `=#.${name}`,
        debounce: true,
        content
    };
}

// Totals of an allocation attribute in the viewport populations of the scope line and the memline
export function withViewportAttributeTotals(attributeName, content) {
    return withScopeValue('viewportTotals', `=[
        scopeBreakdown().populationViewport,
        scopeProfile().memline.breakdowns[0].populationViewport
    ].[$]`, `
        $tracks: "${attributeName}".viewportAllocationAttribute();
        {
            tracks: $tracks,
            total: $tracks.sum(=> value) or 0,
            columnMax: "${attributeName}".allocationAttributeColumnMax()
        }
    `, content);
}

// Scales of the histogram of a row (by its dictionary index) over the whole line viewport: the total of tracks
// for its columns and the track itself for their shadow, at the duration of the columns shown
export const viewportTrackScales = {
    scaleMax: '=#.viewportTotals.value.columnMax.total',
    binsMax: '=#.viewportTotals.value.columnMax.tracks[index]'
};

// Share of a row's attribute value (by its dictionary index) among the viewport totals, in percent
export const viewportShare = '$viewport: #.viewportTotals.value; $viewport.total ? 100 * $viewport.tracks[index].value / $viewport.total : 0';

export function viewportShareText(format = 'toFixed(2)') {
    return scopeValueContent('viewportTotals', `text:${viewportShare} | ${format}`);
}
