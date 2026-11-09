// Totals of an allocation attribute over the line viewport, computed once per change of the viewport or filters
// for the labels of a section; rows keep their whole-line set and order, so they don't change while zooming
export function withViewportAttributeTotals(attributeName, content) {
    return {
        view: 'line-metrics-value',
        name: 'viewportTotals',
        metrics: `=[
            scopeBreakdown().populationViewport,
            scopeProfile().memline.breakdowns[0].populationWindow
        ].[$]`,
        value: `
            $tracks: "${attributeName}".viewportAllocationAttribute();
            { tracks: $tracks, total: $tracks.sum(=> value) or 0 }
        `,
        content
    };
}

// Share of a row's attribute value (by its dictionary index) among the viewport totals, in percent
export const viewportShare = '$viewport: #.viewportTotals.value; $viewport.total ? 100 * $viewport.tracks[index].value / $viewport.total : 0';

export function viewportShareText(format = 'toFixed(2)') {
    return {
        view: 'update-on-line-metrics-changes',
        metrics: '=#.viewportTotals',
        debounce: true,
        content: `text:${viewportShare} | ${format}`
    };
}
