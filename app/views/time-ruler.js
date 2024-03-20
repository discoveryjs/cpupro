const { utils } = require('@discoveryjs/discovery');
const { formatMicrosecondsTime } = require('../prepare/time-utils.js');
const usage = require('./time-ruler.usage.js').default;

function computeStep(n) {
    let b = 1;

    while (n > 10) {
        b *= 10;
        n = Math.floor(n / 10);
    }

    return n > 5 ? b : n >= 2.5 ? b / 2 : b / 4;
}

function nullIfNotNumber(value) {
    return Number.isFinite(value) ? value : null;
}
function createState(duration, segments, selectionStart = null, selectionEnd = null) {
    selectionStart = nullIfNotNumber(selectionStart);
    selectionEnd = nullIfNotNumber(selectionEnd);

    if (!segments) {
        segments = 1000;
    }

    let segmentStart = null;
    let segmentEnd = null;
    let timeStart = null;
    let timeEnd = null;
    let start = null;
    let end = null;

    if (selectionStart !== null && selectionEnd !== null) {
        // align selection range to segment boundaries
        segmentStart = Math.min(Math.floor(selectionStart * segments), segments - 1);
        segmentEnd = Math.min(Math.floor(selectionEnd * segments), segments - 1);

        if (segmentEnd === selectionEnd * segments && segmentStart !== segmentEnd) {
            segmentEnd--;
        }

        // align fraction to segment boundaries
        start = segmentStart / segments;
        end = (segmentEnd + 1) / segments;

        // align time range to segment boundaries
        // use ceil() for timeStart and floor() for timeEnd to ensure a division by duration
        // will give a range inside of selection
        timeStart = Math.ceil(start * duration);
        timeEnd = Math.min(Math.floor(end * duration), duration);
    }

    return {
        duration,
        segments,
        start,
        end,
        segmentStart,
        segmentEnd,
        timeStart,
        timeEnd
    };
}

let startSelectingRange = null;
let startSelectingPointerX = null;
let startSelectingPointerY = null;
let prevAnchorStart = null;
let prevAnchorEnd = null;
let currentViewEl = null;
const viewByEl = new WeakMap();
const detailsTooltip = new discovery.view.Popup({
    className: 'view-time-ruler-tooltip',
    position: 'pointer',
    positionMode: 'natural',
    pointerOffsetX: 30,
    pointerOffsetY: 15,
    showDelay: 100
});

function getRulerSegmentForPoint(timeRulerEl, x) {
    const { segments } = viewByEl.get(timeRulerEl);
    const rect = timeRulerEl.getBoundingClientRect();
    const width = timeRulerEl.clientWidth;
    const segmentsCount = segments || width;
    const fractionRaw = Math.min(width, Math.max(0, x - rect.left)) / width;
    const fraction = Math.round(fractionRaw * width) / width; // round to pixel
    // const segment = Math.min(Math.floor(fraction * segmentsCount), segmentsCount - 1);
    // console.log(fraction, segment);

    return { fraction, segmentsCount };
}

function updateRulerSelection(timeRulerEl, x) {
    let { fraction, segmentsCount } = getRulerSegmentForPoint(timeRulerEl, x);
    const hasSelection = timeRulerEl?.dataset.state === 'selected';
    const {
        data,
        context,
        render,
        state: currentState,
        duration,
        name,
        details,
        onChange
    } = viewByEl.get(timeRulerEl);

    if (timeRulerEl !== currentViewEl) {
        detailsTooltip.hide();

        if (hasSelection) {
            prevAnchorStart = currentState.start;
            prevAnchorEnd = currentState.end;
        } else {
            timeRulerEl.dataset.state = 'hovered';
            prevAnchorStart = null;
            prevAnchorEnd = null;
        }
    }

    if (fraction !== prevAnchorEnd || hasSelection) {
        if (!hasSelection) {
            prevAnchorEnd = fraction;
        }

        // create new state
        const selectionStart = Math.min(prevAnchorStart !== null ? prevAnchorStart : prevAnchorEnd, prevAnchorEnd);
        const selectionEnd = Math.max(prevAnchorStart !== null ? prevAnchorStart : prevAnchorEnd, prevAnchorEnd);
        const hoverState = createState(duration, segmentsCount, selectionStart, selectionEnd);
        const newState = prevAnchorStart !== null
            ? hoverState
            : createState(duration, segmentsCount);

        // update visual bound of the selection
        if (!hasSelection) {
            timeRulerEl.style.setProperty('--selection-start', hoverState.start);
            timeRulerEl.style.setProperty('--selection-end', hoverState.end);
        }

        // display details tooltip if needed
        if (details) {
            if (!hasSelection || (fraction >= selectionStart && fraction <= selectionEnd)) {
                detailsTooltip.show(timeRulerEl, (el) =>
                    render(el, details, data, {
                        ...context,
                        ...hasSelection
                            ? newState
                            : hoverState
                    })
                );
            } else {
                detailsTooltip.hide();
            }
        }

        // update state if needed
        if (!utils.equal(currentState, newState)) {
            Object.assign(currentState, newState);

            if (typeof onChange === 'function') {
                onChange(newState, name, timeRulerEl, data, context);
            }
        }
    }
}

// prevent issues when a potential selection started on dragable or text selectable element
discovery.addHostElEventListener('dragstart', (e) => {
    if (currentViewEl !== null) {
        e.preventDefault();
    }
}, true);
discovery.addHostElEventListener('selectstart', (e) => {
    if (currentViewEl !== null) {
        e.preventDefault();
    }
}, true);

// track pointer pointer buttons
discovery.addGlobalEventListener('pointerup', () => {
    // cancel selection if not started
    startSelectingRange = null;
});
discovery.addHostElEventListener('pointerdown', ({ buttons, pointerId, x, y }) => {
    // do nothing when not over a time-ruler element or not a main button is pressed
    if (currentViewEl === null || (buttons & 1) === 0) {
        return;
    }

    // move time-ruler in hover mode when no selected range
    if (currentViewEl.dataset.state === 'selected') {
        const { fraction } = getRulerSegmentForPoint(currentViewEl, x);

        if (fraction > prevAnchorStart && fraction < prevAnchorEnd) {
            return;
        }

        currentViewEl.dataset.state = 'hovered';
    }

    // reset selection state and remenber a selection start point coordinates
    prevAnchorStart = null;
    prevAnchorEnd = null;
    startSelectingPointerX = x;
    startSelectingPointerY = y;
    updateRulerSelection(currentViewEl, x);

    // create a callback on selection start
    startSelectingRange = () => {
        const { fraction } = getRulerSegmentForPoint(currentViewEl, startSelectingPointerX);

        startSelectingRange = null;
        prevAnchorStart = fraction;
        currentViewEl.dataset.state = 'selecting';

        currentViewEl.setPointerCapture(pointerId);
        currentViewEl.addEventListener('pointerup', () => {
            currentViewEl.releasePointerCapture(pointerId);
            currentViewEl.dataset.state = 'selected';
        }, { capture: true, once: true });
    };
});

// thack pointer to determine the pointer is over a time-ruler;
// using such an approach since time-ruler might be overlaped by another content
utils.pointerXY.subscribe(({ x, y }) => {
    if (startSelectingRange !== null) {
        // ignore if pointer is not moved from selection start point at least 2px
        if (Math.abs(startSelectingPointerX - x) < 2 && Math.abs(startSelectingPointerY - y) < 2) {
            return;
        }

        startSelectingRange();
    }

    // if there is a time-ruler in selecting mode then just update a selection,
    // no need to check elements under the pointer
    if (currentViewEl?.dataset.state === 'selecting') {
        updateRulerSelection(currentViewEl, x);
        return;
    }

    // get time-ruler element candidate under the pointer
    const elementsFromPoint = discovery.dom.root.elementsFromPoint(x, y);
    const candidateEl = elementsFromPoint.find(el => viewByEl.has(el)) || null;

    // check for closest element to cursor is in a subtree of the common parent,
    // this excludes displaying a details popup when the cursor is over another popup or sticky element (e.g. page-header)
    const timeRulerEl = candidateEl?.parentNode.contains(elementsFromPoint[0])
        ? candidateEl
        : null;

    // update time-ruler selection when its element is found and met all the conditions
    if (timeRulerEl) {
        updateRulerSelection(timeRulerEl, x);
    } else if (currentViewEl) {
        // there is no time-ruler element under the pointer that met the conditions,
        // but we had such previously, so hide its details popup and reset the state if needed
        detailsTooltip.hide();

        if (currentViewEl.dataset.state !== 'selected') {
            currentViewEl.dataset.state = 'none';
        }
    }

    // remember time-ruler element as current if any
    currentViewEl = timeRulerEl;
});

discovery.view.define('time-ruler', function(el, options, data, context) {
    const {
        duration,
        segments: segmentsRaw,
        selectionStart = null,
        selectionEnd = null,
        labels = 'top',
        name = 'ruler',
        details,
        onInit,
        onChange
    } = options;
    const segments = Number.isFinite(segmentsRaw) ? Math.min(segmentsRaw, duration) : null;

    // create state
    const state = createState(
        duration,
        segments,
        selectionStart === null ? null : selectionStart / duration,
        selectionEnd === null ? null : selectionEnd / duration
    );

    if (state.start !== null) {
        el.dataset.state = 'selected';
        el.style.setProperty('--selection-start', state.start);
        el.style.setProperty('--selection-end', state.end);
    } else {
        el.dataset.state = 'none';
    }

    // register the view
    viewByEl.set(el, {
        data,
        context,
        state,
        render: this.render,
        duration,
        segments,
        name,
        details,
        onChange
    });

    // apply interval marker labels position if any
    el.dataset.labels = ['top', 'bottom', 'both'].includes(labels)
        ? labels
        : 'none';

    // draw interval markers
    const timeRulerStep = computeStep(duration);
    for (
        let time = 0;
        time < duration - timeRulerStep / 10;
        time += timeRulerStep
    ) {
        const intervalMarkerEl = el.appendChild(document.createElement('div'));

        intervalMarkerEl.className = 'interval-marker';
        intervalMarkerEl.style.setProperty('--offset', time / duration);
        intervalMarkerEl.dataset.title = formatMicrosecondsTime(time, duration);
    }

    // overlay element
    const selectionOverlayEl = el.appendChild(document.createElement('div'));
    selectionOverlayEl.className = 'view-time-ruler__selection-overlay';

    // call init state callback if any
    if (typeof onInit === 'function') {
        onInit(state, name, el, data, context);
    }
}, { usage });
