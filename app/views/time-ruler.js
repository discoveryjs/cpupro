const { utils } = require('@discoveryjs/discovery');
const { formatMicrosecondsTime } = require('../prepare/time-utils.js');
const usage = require('./time-ruler.usage.js').default;

const SELECTION_NONE = 'none';
const SELECTION_HOVERED = 'hovered';
const SELECTION_SELECTING = 'selecting';
const SELECTION_SELECTED = 'selected';
const MOVING_NONE = 'none';
const MOVING_TRIGGER = 'trigger';
const MOVING_RANGE = 'range';

const viewByEl = new WeakMap();
const detailsTooltip = new discovery.view.Popup({
    className: 'view-time-ruler-tooltip',
    position: 'pointer',
    positionMode: 'natural',
    pointerOffsetX: 30,
    pointerOffsetY: 15,
    showDelay: 100
});

let startSelectingRange = null;
let startSelectingPointerX = null;
let startSelectingPointerY = null;
let movingRange = null;
let movingPointerDelta = null;
let movingMode = MOVING_NONE;
let prevAnchorStart = null;
let prevAnchorEnd = null;
let currentViewEl = null;

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

function discardCurrentView() {
    if (currentViewEl) {
        detailsTooltip.hide();

        if (currentViewEl.dataset.state !== SELECTION_SELECTED) {
            currentViewEl.dataset.state = SELECTION_NONE;
        }

        currentViewEl = null;
    }
}

function getRulerFractionForPoint(timeRulerEl, x) {
    const { segments, state: currentState } = viewByEl.get(timeRulerEl);
    const rect = timeRulerEl.getBoundingClientRect();
    const width = timeRulerEl.clientWidth;
    const segmentsCount = segments || width;
    const fractionRaw = Math.min(width, Math.max(0, x - rect.left)) / width;
    const fraction = Math.round(fractionRaw * width) / width; // round to pixel
    // const segment = Math.min(Math.floor(fraction * segmentsCount), segmentsCount - 1);
    // console.log(fraction, segment);

    return { fraction, segmentsCount, rect, width, currentState };
}

function updateRulerSelection(timeRulerEl, x) {
    const delta = movingMode !== MOVING_NONE ? movingPointerDelta : 0;
    let { fraction, segmentsCount } = getRulerFractionForPoint(timeRulerEl, x + delta);
    const hasSelection = timeRulerEl.dataset.state === SELECTION_SELECTED;
    const isSelecting = timeRulerEl.dataset.state === SELECTION_SELECTING;
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
            timeRulerEl.dataset.state = SELECTION_HOVERED;
            prevAnchorStart = null;
            prevAnchorEnd = null;
        }
    }

    if (fraction !== prevAnchorEnd || hasSelection) {
        if (movingMode === MOVING_RANGE) {
            fraction = Math.min(fraction, 1 - movingRange);
            prevAnchorStart = fraction + movingRange;
        }

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

            if (isSelecting) {
                timeRulerEl.dataset.activeTrigger =
                    movingMode === MOVING_RANGE
                        ? 'both'
                        : selectionEnd === prevAnchorEnd
                            ? 'finish'
                            : 'start';
            }
        }

        // update details tooltip visibility when specified
        if (details) {
            // display if no selection or inside a selection range
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

// discard the current ruler when the pointer leaves the document;
// this has no effect when selection mode is active, as currentView is capturing pointer events
discovery.addGlobalEventListener('pointerleave', discardCurrentView, true);

// track pointer pointer buttons
discovery.addGlobalEventListener('pointerup', () => {
    // cancel selection if not started
    startSelectingRange = null;
}, true);
discovery.addHostElEventListener('pointerdown', ({ buttons, pointerId, x, y, target }) => {
    // do nothing when not over a time-ruler element or not a main button is pressed
    if (currentViewEl === null || (buttons & 1) === 0) {
        return;
    }

    // move time-ruler in hover mode when no selected range
    if (currentViewEl.dataset.state === SELECTION_SELECTED) {
        const rulerViewEl = currentViewEl; // preserve reference to view element, since it might be changed before pointerup event
        const moverEl = rulerViewEl.querySelector('.view-time-ruler__selection-overlay-mover');
        const { fraction, rect, width, currentState } = getRulerFractionForPoint(rulerViewEl, x);

        if (moverEl.contains(target)) {
            switch (target.dataset.trigger) {
                case 'start': {
                    movingMode = MOVING_TRIGGER;
                    movingPointerDelta = rect.left + currentState.start * width - x;
                    prevAnchorStart = currentState.end;
                    break;
                }

                case 'finish': {
                    movingMode = MOVING_TRIGGER;
                    movingPointerDelta = rect.left + currentState.end * width - x;
                    prevAnchorStart = currentState.start;
                    break;
                }

                default:
                    movingMode = MOVING_RANGE;
                    movingPointerDelta = rect.left + currentState.start * width - x;
                    movingRange = currentState.end - currentState.start;
            }

            rulerViewEl.dataset.state = SELECTION_SELECTING;
            rulerViewEl.setPointerCapture(pointerId);
            rulerViewEl.addEventListener('pointerup', () => {
                rulerViewEl.releasePointerCapture(pointerId);
                rulerViewEl.dataset.state = SELECTION_SELECTED;
                rulerViewEl.dataset.activeTrigger = 'none';
                movingMode = MOVING_NONE;
            }, { capture: true, once: true });

            return;
        }

        if (fraction > prevAnchorStart && fraction < prevAnchorEnd) {
            return;
        }

        currentViewEl.dataset.state = SELECTION_HOVERED;
    }

    // reset selection state and remenber a selection start point coordinates
    prevAnchorStart = null;
    prevAnchorEnd = null;
    startSelectingPointerX = x;
    startSelectingPointerY = y;
    updateRulerSelection(currentViewEl, x);

    // create a callback on selection start
    startSelectingRange = () => {
        const { fraction } = getRulerFractionForPoint(currentViewEl, startSelectingPointerX);
        const rulerViewEl = currentViewEl; // preserve reference to view element, since it might be changed before pointerup event

        startSelectingRange = null;
        prevAnchorStart = fraction;
        rulerViewEl.dataset.state = SELECTION_SELECTING;

        rulerViewEl.setPointerCapture(pointerId);
        rulerViewEl.addEventListener('pointerup', () => {
            rulerViewEl.releasePointerCapture(pointerId);
            rulerViewEl.dataset.state = SELECTION_SELECTED;
            rulerViewEl.dataset.activeTrigger = 'none';
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
    if (currentViewEl?.dataset.state === SELECTION_SELECTING) {
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
        discardCurrentView();
    }

    // remember time-ruler element as current if any
    currentViewEl = timeRulerEl;
});

function formatMemory(size, total) {
    switch (true) {
        case total < 1_000_000:
            return `${(size / 1_000).toFixed(1).replace(/\.0$/, '')}Kb`;

        default:
            return `${(size / 1_000_000).toFixed(1).replace(/\.0$/, '')}Mb`;
    }
}

discovery.view.define('time-ruler', function(el, options, data, context) {
    const {
        duration,
        segments: segmentsRaw,
        selectionStart = null,
        selectionEnd = null,
        valueType = context.currentProfile?.type || 'time',
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
        el.dataset.state = SELECTION_SELECTED;
        el.style.setProperty('--selection-start', state.start);
        el.style.setProperty('--selection-end', state.end);
    } else {
        el.dataset.state = SELECTION_NONE;
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
        intervalMarkerEl.dataset.title = valueType === 'memory'
            ? formatMemory(time, duration)
            : formatMicrosecondsTime(time, duration);
    }

    // overlay element
    el.appendChild(
        utils.createElement('div', 'view-time-ruler__selection-overlay', [
            utils.createElement('div', 'view-time-ruler__selection-overlay-mover', [
                utils.createElement('div', {
                    class: 'view-time-ruler__selection-overlay-mover-trigger',
                    'data-trigger': 'start'
                }),
                utils.createElement('div', {
                    class: 'view-time-ruler__selection-overlay-mover-trigger',
                    'data-trigger': 'finish'
                })
            ])
        ])
    );

    // call init state callback if any
    if (typeof onInit === 'function') {
        onInit(state, name, el, data, context);
    }
}, { usage });
