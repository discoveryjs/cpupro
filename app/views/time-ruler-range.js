function segmentCount(duration, segments) {
    return Number.isFinite(segments) && segments > 0 && duration > 0
        ? Math.max(1, Math.min(Math.floor(segments), Math.floor(duration)))
        : null;
}

function boundary(duration, segments, index) {
    return index === segments ? duration : Math.round(index * duration / segments);
}

function segmentIndex(duration, segments, value, end) {
    let left = 0;
    let right = segments;

    while (left < right) {
        const middle = Math.floor((left + right) / 2);
        const position = boundary(duration, segments, middle);

        if (position < value || (!end && position === value)) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    return Math.min(segments - 1, left - 1);
}

export function createState(duration, segments, selectionStart = null, selectionEnd = null) {
    segments = segmentCount(duration, segments);
    const selected = Number.isFinite(duration) && duration > 0 &&
        Number.isFinite(selectionStart) && Number.isFinite(selectionEnd);
    const timeStart = selected ? Math.max(0, Math.min(duration, selectionStart, selectionEnd)) : null;
    const timeEnd = selected ? Math.max(0, Math.min(duration, Math.max(selectionStart, selectionEnd))) : null;

    return {
        duration,
        segments,
        start: selected ? timeStart / duration : null,
        end: selected ? timeEnd / duration : null,
        segmentStart: selected && segments ? segmentIndex(duration, segments, timeStart, false) : null,
        segmentEnd: selected && segments ? segmentIndex(duration, segments, timeEnd, true) : null,
        timeStart,
        timeEnd
    };
}

export function createSelectionState(duration, segments, anchor, pointer) {
    segments = segmentCount(duration, segments);
    if (!segments) {
        return createState(duration, segments);
    }

    const start = Math.max(0, Math.min(1, anchor, pointer));
    const end = Math.max(0, Math.min(1, Math.max(anchor, pointer)));
    const first = Math.min(segments - 1, Math.floor(start * segments));
    const last = Math.min(segments, Math.max(first + 1, Math.ceil(end * segments)));

    return createState(duration, segments, boundary(duration, segments, first), boundary(duration, segments, last));
}

export function moveState(duration, segments, selection, deltaFraction) {
    segments = segmentCount(duration, segments);
    const delta = segments
        ? Math.round(Math.round(deltaFraction * segments) * duration / segments)
        : Math.round(deltaFraction * duration);
    const shift = Math.max(-selection.timeStart, Math.min(duration - selection.timeEnd, delta));

    return createState(duration, segments, selection.timeStart + shift, selection.timeEnd + shift);
}

export function resizeState(duration, segments, anchor, pointer) {
    segments = segmentCount(duration, segments);
    const fraction = Math.max(0, Math.min(1, pointer));
    const position = segments
        ? boundary(duration, segments, Math.round(fraction * segments))
        : Math.round(fraction * duration);

    return createState(duration, segments, anchor, position);
}
