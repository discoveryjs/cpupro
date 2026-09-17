export function normalizeRange(range) {
    const { start, end } = typeof range === 'number'
        ? { start: 0, end: range }
        : Array.isArray(range)
            ? { start: range[0], end: range[1] }
            : range;

    return {
        start: Math.min(start, end),
        end: Math.max(start, end)
    };
}

export function normalizeSelection(selection, multiple) {
    if (selection == null) {
        return null;
    }

    if (!multiple) {
        return normalizeRange(selection);
    }

    const ranges = selection.map(normalizeRange).sort((left, right) => left.start - right.start);
    const result = [];

    for (const range of ranges) {
        const previous = result.at(-1);

        if (previous && previous.end >= range.start) {
            previous.end = Math.max(previous.end, range.end);
        } else {
            result.push(range);
        }
    }

    return result;
}

/**
 * @param {number | [number, number] | { start: number, end: number }} range
 * @param {number | number[] | null} [segments]
 * @param {{ start: number, end: number } | { start: number, end: number }[] | null} [selection]
 * @param {boolean} [multiple]
 */
export function createState(range, segments = null, selection = null, multiple = false) {
    range = normalizeRange(range);
    const length = range.end - range.start;
    let boundaries = null;

    if (length > 0) {
        if (Number.isFinite(segments) && segments >= 1) {
            const count = Math.floor(segments);
            boundaries = Array.from({ length: count + 1 }, (_, index) =>
                index === count ? range.end : range.start + index * length / count
            );
        } else if (Array.isArray(segments) && segments.length > 1 &&
                segments[0] === range.start && segments.at(-1) === range.end &&
                segments.every((value, index) => Number.isFinite(value) && (index === 0 || value > segments[index - 1]))) {
            boundaries = segments.slice();
        }
    }

    return { range, length, segments: boundaries, selection: normalizeSelection(selection, multiple) };
}

function boundaryIndex(segments, value, upper = false) {
    let start = 0;
    let end = segments.length;

    while (start < end) {
        const middle = Math.floor((start + end) / 2);

        if (upper ? segments[middle] <= value : segments[middle] < value) {
            start = middle + 1;
        } else {
            end = middle;
        }
    }

    return start;
}

export function rangeToSegments(range, segments) {
    if (!segments || !range || range.end < segments[0] || range.start >= segments.at(-1) ||
            (range.end === segments[0] && range.start < range.end)) {
        return null;
    }

    const start = Math.max(0, boundaryIndex(segments, range.start, true) - 1);
    const end = Math.min(segments.length - 1, Math.max(start + 1, boundaryIndex(segments, range.end)));

    return { start, end };
}

export function valueAt(state, fraction) {
    return state.range.start + Math.max(0, Math.min(1, fraction)) * state.length;
}

function nearestBoundary(segments, value) {
    const index = boundaryIndex(segments, value);
    const left = segments[Math.max(0, index - 1)];
    const right = segments[Math.min(segments.length - 1, index)];

    return value - left < right - value ? left : right;
}

export function selectRange(state, anchor, pointer) {
    const range = normalizeRange({ start: valueAt(state, anchor), end: valueAt(state, pointer) });

    if (state.segments) {
        const indices = rangeToSegments(range, state.segments);
        const last = state.segments.length - 1;

        return indices
            ? { start: state.segments[indices.start], end: state.segments[indices.end] }
            : { start: state.segments[last - 1], end: state.segments[last] };
    }

    return range;
}

export function moveRange(state, selection, deltaFraction) {
    let delta = deltaFraction * state.length;

    if (state.segments && delta !== 0) {
        delta = nearestBoundary(state.segments, selection.start + delta) - selection.start;
    }

    const shift = Math.max(state.range.start - selection.start, Math.min(state.range.end - selection.end, delta));

    return {
        start: selection.start + shift,
        end: selection.end + shift
    };
}

export function resizeRange(state, anchor, pointer, minimum = 0, direction = 1) {
    const value = valueAt(state, pointer);
    let position = state.segments ? nearestBoundary(state.segments, value) : value;

    direction = value < anchor ? -1 : value > anchor ? 1 : direction;

    if (anchor === state.range.start) {
        direction = 1;
    } else if (anchor === state.range.end) {
        direction = -1;
    }

    const limit = state.segments
        ? state.segments[direction < 0
            ? boundaryIndex(state.segments, anchor) - 1
            : boundaryIndex(state.segments, anchor, true)]
        : Math.max(state.range.start, Math.min(state.range.end, anchor + direction * minimum));

    position = direction < 0 ? Math.min(position, limit) : Math.max(position, limit);

    return normalizeRange({
        start: anchor,
        end: position
    });
}
