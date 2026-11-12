import type { ProfileLine } from './types.js';
import type { PopulationFiltered } from '../computations/population.js';
import { equalRanges, rangesEnvelope, type Range, type RangeSet } from '../computations/coordinates.js';
import { RangeView } from '../computations/range.js';

export function applyRangeToPopulation(view: RangeView, filtered: PopulationFiltered) {
    // One-way migration adapter. Retire when derived populations consume scope coverage directly.
    // Only O(interval count) descriptors are created; the existing values/workspace arrays are reused.
    const update = () => filtered.setRanges(view.ranges === null ? null : view.coverage);
    const unsubscribe = view.subscribe(update);

    update();

    return unsubscribe;
}

type ScaleLine = Pick<ProfileLine, 'kind' | 'range' | 'profile'>;

// The viewport without a request: the extent of the scale a line's events are placed on (absolute coordinates).
// Time is the clock of the session the line's profile is in, so a line of time spans the capture bounds of every
// profile of its session; other lines are scales of their own. Histograms without a zoom show it, zooming narrows
// the viewport within it, and windows of a zoom are cells of its halving levels
export function lineViewportBounds(line: ScaleLine): Range {
    const profiles = line.kind === 'time'
        ? line.profile?.thread?.process?.session.profiles ?? []
        : [];
    let { start, end } = line.range.resolvedExtent;

    for (let i = 0; i < profiles.length; i++) {
        const timeline = profiles[i].timeline;

        if (timeline) {
            start = Math.min(start, timeline.axisStart);
            end = Math.max(end, timeline.axisEnd);
        }
    }

    return { start, end };
}

// The window of a viewport: aligned cells of the extent's halving levels, at the level whose cell is the largest
// within twice the viewport size. The window contains the viewport and is 1 to 4 viewport sizes, so a fixed number
// of window bins gives at least one bin per display column at a quarter of that number of columns
export function viewportWindow(ranges: RangeSet | null, extent: Range): RangeSet | null {
    if (ranges === null || ranges.length === 0) {
        return ranges;
    }

    const { start, end } = rangesEnvelope(ranges);

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

    const { start, end } = rangesEnvelope(ranges);
    const windowBounds = window === null
        ? extent
        : rangesEnvelope(window);

    return (
        windowBounds.start <= start &&
        end <= windowBounds.end &&
        windowBounds.end - windowBounds.start <= 4 * (end - start)
    );
}

// The extent windows of a line's zoom are cells of: the requested viewport, or the line's scale without a request,
// so windows are aligned to the bins of histograms without a zoom
export function lineWindowExtent(line: ScaleLine & Pick<ProfileLine, 'viewport'>): Range {
    const ranges = line.viewport.selection.ranges;

    return ranges?.length
        ? rangesEnvelope(ranges)
        : lineViewportBounds(line);
}

// The window of the zoom within the viewport: aligned cells of the viewport's halving levels, or the viewport itself.
// The window is kept while it holds the zoom, so zooming and panning inside it change only how histograms are
// displayed. A new viewport is shown whole, it ends the zoom request and gets a window of its own
export function prepareLineWindow(line: ProfileLine) {
    const { viewport, zoom, window } = line;
    const zoomWindow = () => {
        const ranges = zoom.selection.ranges ?? viewport.selection.ranges;

        return viewportWindow(ranges, lineWindowExtent(line)) ?? viewport.selection.ranges;
    };
    const unsubscribeViewport = viewport.selection.subscribe(() => {
        zoom.selection.resetRange();
        window.selection.setRanges(zoomWindow());
    });
    const unsubscribeZoom = zoom.selection.subscribe(() => {
        const ranges = zoom.selection.ranges ?? viewport.selection.ranges;

        // A window for the whole scale is no request, there is no viewport then
        if (!windowHolds(window.selection.ranges, ranges, lineViewportBounds(line))) {
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
