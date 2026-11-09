import { validateRange, type Range } from '../prepare/computations/coordinates.js';
import type { ProfileLine } from '../prepare/lines/types.js';

type ViewportLine = Pick<ProfileLine, 'kind' | 'range' | 'axisStart' | 'axisEnd' | 'viewport'>;
type WindowLine = ViewportLine & Pick<ProfileLine, 'window'>;
type ZoomLine = ViewportLine & Pick<ProfileLine, 'zoom'>;

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
        const extent = lineExtent(line);

        return {
            start: ranges[0]?.start ?? extent.start,
            end: ranges.at(-1)?.end ?? extent.start
        };
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

// Requests a zoom moved inside the viewport, the length of the viewport or more is no request
export function setLineZoom(line: ZoomLine, profiles: readonly { timeline?: ViewportLine | null }[], range: Range) {
    const scope = lineViewport(line, profiles);
    const length = range.end - range.start;
    const start = Math.min(Math.max(range.start, scope.start), scope.end - length);

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

export function viewportRange(viewport: Range, line: Pick<ProfileLine, 'range'>) {
    validateRange(viewport);

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
        binStart: Math.max(0, Math.min(count, Math.floor(skip / step))),
        binEnd: Math.max(0, Math.min(count, Math.ceil((extent.end - viewport.start) / step)))
    };
}

export const methods = {
    lineExtent,
    timestampExtent,
    lineViewport,
    lineViewportBounds,
    lineZoom,
    lineWindow,
    viewportRange
};
