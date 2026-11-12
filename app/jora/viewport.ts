import { rangesEnvelope, type Range } from '../prepare/computations/coordinates.js';
import type { ProfileLine } from '../prepare/lines/types.js';
import { lowerBound } from '../prepare/computations/misc.js';
import { lineEventPositions } from '../prepare/computations/line-mapping.js';

type ViewportLine = Pick<ProfileLine, 'kind' | 'range' | 'axisStart' | 'axisEnd' | 'viewport'>;
type WindowLine = ViewportLine & Pick<ProfileLine, 'window'>;
type ZoomLine = ViewportLine & Pick<ProfileLine, 'zoom' | 'breakdowns'>;

// Zooming in stops where a zoom holds this many events (samples, allocations) at the average density of the viewport,
// so the deepest zoom still has an event per column of a histogram on average; denser data zooms in deeper
const ZOOM_MIN_EVENTS = 500;

export function lineExtent(line: Pick<ProfileLine, 'range'>) {
    const { frame, extent } = line.range;

    return {
        start: frame.resolveValue(extent.start),
        end: frame.resolveValue(extent.end)
    };
}

export function timestampExtent(line: Pick<ProfileLine, 'axisStart' | 'axisEnd'>, lastTime = 0, origin = line.axisStart) {
    return {
        start: line.axisStart,
        end: Math.max(line.axisEnd, origin + lastTime)
    };
}

export function lineViewport(line: ViewportLine, profiles: readonly { timeline?: ViewportLine | null }[] = []): Range {
    const ranges = line.viewport.selection.ranges;

    if (ranges) {
        const { start } = lineExtent(line);

        // An empty request is an empty range at the start of the extent
        return ranges.length > 0
            ? rangesEnvelope(ranges)
            : { start, end: start };
    }

    return lineViewportBounds(line, profiles);
}

// The viewport without a request; zooming narrows the viewport within it
export function lineViewportBounds(line: ViewportLine, profiles: readonly { timeline?: ViewportLine | null }[] = []): Range {
    const extent = lineExtent(line);

    // Current recordings share timestamps. Cumulative bytes have no cross-thread coordinate relation.
    if (line.kind === 'time' && profiles.length > 0) {
        for (const { timeline } of profiles) {
            if (timeline) {
                extent.start = Math.min(extent.start, timeline.axisStart);
                extent.end = Math.max(extent.end, timeline.axisEnd);
            }
        }
    }

    return extent;
}

// The range displayed by timelines: the zoom within the viewport, the viewport itself without a zoom request
export function lineZoom(line: ZoomLine, profiles: readonly { timeline?: ViewportLine | null }[] = []): Range {
    return line.zoom.selection.ranges
        ? lineViewport({ ...line, viewport: line.zoom }, profiles)
        : lineViewport(line, profiles);
}

// Follows changes of the displayed range: a new viewport without a zoom request changes it too
export function subscribeLineZoom(line: Pick<ProfileLine, 'viewport' | 'zoom'>, callback: () => void) {
    const unsubscribeViewport = line.viewport.subscribe(callback);
    const unsubscribeZoom = line.zoom.subscribe(callback);

    return () => {
        unsubscribeViewport();
        unsubscribeZoom();
    };
}

// The shortest zoom of a line: the length holding ZOOM_MIN_EVENTS events at the average density of the viewport
export function lineZoomMinLength(line: ZoomLine, profiles: readonly { timeline?: ViewportLine | null }[] = []) {
    const scope = lineViewport(line, profiles);
    const [range] = line.range.frame.rebase([scope]);
    const { starts } = lineEventPositions(line);
    const events = lowerBound(starts, range.end) - lowerBound(starts, range.start);

    return (scope.end - scope.start) * Math.min(1, ZOOM_MIN_EVENTS / events);
}

// Requests a zoom moved inside the viewport, the length of the viewport or more is no request. A zoom shorter
// than the shortest one stops at it: the request is scaled to it around the point it scales the current zoom around
// when zooming in, around its middle otherwise (e.g. panning a zoom shared by a profile with a shorter one)
export function setLineZoom(line: ZoomLine, profiles: readonly { timeline?: ViewportLine | null }[], range: Range) {
    const scope = lineViewport(line, profiles);
    const minLength = lineZoomMinLength(line, profiles);
    let { start: requestStart, end: requestEnd } = range;

    if (requestEnd - requestStart < minLength) {
        const current = lineZoom(line, profiles);
        const scale = (requestEnd - requestStart) / (current.end - current.start);
        const anchor = scale < 1
            ? (requestStart - scale * current.start) / (1 - scale)
            : (requestStart + requestEnd) / 2;
        // The position of the anchor within the zoom, the same in the current zoom and the request when zooming in
        const position = scale < 1 ? (anchor - current.start) / (current.end - current.start) : 0.5;

        requestStart = anchor - position * minLength;
        requestEnd = requestStart + minLength;
    }

    const length = requestEnd - requestStart;
    const start = Math.min(Math.max(requestStart, scope.start), scope.end - length);

    if (length >= scope.end - scope.start) {
        line.zoom.selection.resetRange();
    } else {
        line.zoom.selection.setRange(start, start + length);
    }
}

// The range of histogram data: the line's window, which contains the zoom
export function lineWindow(line: WindowLine, profiles: readonly { timeline?: ViewportLine | null }[] = []): Range {
    return lineViewport({ ...line, viewport: line.window }, profiles);
}

// The view rejects a viewport that isn't a finite ordered range
export function viewportRange(viewport: Range, line: Pick<ProfileLine, 'range'>) {
    // Display placement shares the existing selection request; it never moves the population frame.
    return line.range.selection.view(
        { start: 0, end: viewport.end - viewport.start },
        viewport.start
    );
}

export function binningRange(line: Pick<ProfileLine, 'axisTotal' | 'range'>, viewport: Range | null, count = 500) {
    const extent = viewport
        ? lineExtent(line)
        : { start: 0, end: line.axisTotal };

    return rangeBins(extent, viewport || extent, count);
}

export function rangeBins(extent: Range, viewport: Range = extent, count = 500) {
    const total = viewport.end - viewport.start;
    const skip = extent.start - viewport.start;
    const step = total / count;

    return {
        total,
        skip,
        step,
        // Bins of a closed extent: an instant at a bin boundary belongs to the bin it ends, as events at
        // boundaries do, so an extent of an instant has a bin wherever it is
        binStart: Math.max(0, Math.min(count, Math.ceil(skip / step) - 1)),
        binEnd: Math.max(0, Math.min(count, Math.ceil((extent.end - viewport.start) / step)))
    };
}

export const methods = {
    lineExtent,
    timestampExtent,
    lineViewport,
    lineViewportBounds,
    lineZoom,
    lineZoomMinLength,
    lineWindow,
    viewportRange
};
