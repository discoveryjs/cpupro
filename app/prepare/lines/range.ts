import type { ProfileLine } from './types.js';
import type { PopulationFiltered } from '../computations/population.js';
import { equalRanges, type Range, type RangeSet } from '../computations/coordinates.js';
import { RangeView } from '../computations/range.js';

export function applyRangeToPopulation(view: RangeView, filtered: PopulationFiltered) {
    // One-way migration adapter. Retire when derived populations consume scope coverage directly.
    // Only O(interval count) descriptors are created; the existing values/workspace arrays are reused.
    const update = () => filtered.setRanges(view.ranges === null ? null : view.coverage);
    const unsubscribe = view.subscribe(update);

    update();

    return unsubscribe;
}

// The window of a viewport: aligned cells of the extent's halving levels, at the level whose cell is the largest
// within twice the viewport size. The window contains the viewport and is 1 to 4 viewport sizes, so a fixed number
// of window bins gives at least one bin per display column at a quarter of that number of columns
export function viewportWindow(ranges: RangeSet | null, extent: Range): RangeSet | null {
    if (ranges === null || ranges.length === 0) {
        return ranges;
    }

    const start = ranges[0].start;
    const end = ranges[ranges.length - 1].end;

    if (start >= end) {
        return ranges;
    }

    let cell = extent.end - extent.start;

    while (cell > 2 * (end - start)) {
        cell /= 2;
    }

    // Rounding must not leave viewport edges outside
    const windowStart = Math.min(start, extent.start + Math.floor((start - extent.start) / cell) * cell);
    const windowEnd = Math.max(end, extent.start + Math.ceil((end - extent.start) / cell) * cell);

    return windowStart === extent.start && windowEnd === extent.end
        ? null
        : [{ start: windowStart, end: windowEnd }];
}

// Whether a window still serves a viewport: it contains the viewport within 4 viewport sizes
export function windowHolds(window: RangeSet | null, ranges: RangeSet | null, extent: Range) {
    // The window of an unrestricted or an empty viewport is the viewport itself
    if (ranges === null || ranges.length === 0) {
        return equalRanges(window, ranges);
    }

    if (window !== null && window.length === 0) {
        return false;
    }

    const start = ranges[0].start;
    const end = ranges[ranges.length - 1].end;
    const windowStart = window === null ? extent.start : window[0].start;
    const windowEnd = window === null ? extent.end : window[window.length - 1].end;

    return windowStart <= start && end <= windowEnd && windowEnd - windowStart <= 4 * (end - start);
}

// The window of the zoom within the viewport: aligned cells of the viewport's halving levels, or the viewport itself.
// The window is kept while it holds the zoom, so zooming and panning inside it change only how histograms are
// displayed. A new viewport is shown whole, it ends the zoom request and gets a window of its own
export function prepareLineWindow({ viewport, zoom, window }: ProfileLine) {
    const scopeExtent = () => {
        const scope = viewport.selection.ranges;

        return scope?.length ? { start: scope[0].start, end: scope[scope.length - 1].end } : viewport.resolvedExtent;
    };
    const zoomWindow = () => {
        const ranges = zoom.selection.ranges ?? viewport.selection.ranges;
        const scope = scopeExtent();

        if (ranges === null || ranges.length === 0 || (scope.start <= ranges[0].start && ranges[ranges.length - 1].end <= scope.end)) {
            return viewportWindow(ranges, scope) ?? viewport.selection.ranges;
        }

        // A zoom shared by profiles reaches beyond the extent of a line covering a part of their bounds, the cells
        // are aligned to both so the window stays within the zoom sizes
        const extent = {
            start: Math.min(scope.start, ranges[0].start),
            end: Math.max(scope.end, ranges[ranges.length - 1].end)
        };

        return viewportWindow(ranges, extent) ?? [extent];
    };
    const unsubscribeViewport = viewport.selection.subscribe(() => {
        zoom.selection.resetRange();
        window.selection.setRanges(zoomWindow());
    });
    const unsubscribeZoom = zoom.selection.subscribe(() => {
        // A window for the whole line extent is no request, there is no viewport then
        if (!windowHolds(window.selection.ranges, zoom.selection.ranges ?? viewport.selection.ranges, viewport.resolvedExtent)) {
            window.selection.setRanges(zoomWindow());
        }
    });

    window.selection.setRanges(zoomWindow());

    return () => {
        unsubscribeViewport();
        unsubscribeZoom();
    };
}

export function prepareLineRange(line: ProfileLine) {
    const { range, viewport, window, breakdowns } = line;
    const populations = new Set<PopulationFiltered>();
    const subscriptions: (() => void)[] = [prepareLineWindow(line)];

    // Original/source-mapped breakdowns share an executor; subscribe once per distinct population workspace.
    for (const { populationFiltered, populationViewport, populationWindow } of breakdowns) {
        for (const [scope, population] of [[viewport, populationViewport], [window, populationWindow], [range, populationFiltered]] as const) {
            if (populations.has(population)) {
                continue;
            }

            populations.add(population);

            const view = new RangeView(scope.selection, scope.frame, {
                start: 0,
                end: population.population.cumulativeEnd
            });

            subscriptions.push(applyRangeToPopulation(view, population));
        }
    }

    return () => {
        for (const unsubscribe of subscriptions) {
            unsubscribe();
        }
    };
}
