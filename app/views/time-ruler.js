const { utils } = require('@discoveryjs/discovery');
const { formatMicrosecondsTime } = require('../prepare/misc/time-utils.js');
const { resolveScopeProfileLine } = require('../jora/profile.js');
const { createState, createSelectionState, moveState, resizeState } = require('./time-ruler-range.js');
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
let currentViewEl = null;

function computeStep(n) {
    let b = 1;

    while (n > 10) {
        b *= 10;
        n = Math.floor(n / 10);
    }

    return n > 5 ? b : n >= 2.5 ? b / 2 : b / 4;
}

function setStateIfNeeded(el, newState, syncDom = true, notify = true) {
    const view = viewByEl.get(el);
    if (!view) {
        return;
    }
    const { state, onChange, name, data, context } = view;

    if (!utils.equal(state, newState)) {
        const rangeChanged = state.timeStart !== newState.timeStart || state.timeEnd !== newState.timeEnd;
        Object.assign(state, newState);

        if (syncDom) {
            syncStateToDom(el, state);
        }

        if (notify && rangeChanged && typeof onChange === 'function') {
            onChange(newState, name, el, data, context);
        }
    }
}
function syncStartEndToDom(el, start, end) {
    el.style.setProperty('--selection-start', Math.max(0, Number.isFinite(start) ? start : 0));
    el.style.setProperty('--selection-end', Math.min(1, Number.isFinite(end) ? end : 1));
}
function syncStateToDom(el, state) {
    if (state.start !== null) {
        if (el.dataset.state !== SELECTION_SELECTING) {
            el.dataset.state = SELECTION_SELECTED;
        }
        syncStartEndToDom(el, state.start, state.end);
    } else {
        el.dataset.state = SELECTION_NONE;
    }
}

function discardCurrentView() {
    if (currentViewEl) {
        detailsTooltip.hide();

        if (currentViewEl.dataset.state !== SELECTION_SELECTED) {
            currentViewEl.dataset.state = SELECTION_NONE;
        }

        currentViewEl = null;
    }
    startSelectingRange = null;
    movingMode = MOVING_NONE;
    movingRange = null;
    prevAnchorStart = null;
}

function getRulerFractionForPoint(timeRulerEl, x) {
    const { segments, state: currentState } = viewByEl.get(timeRulerEl);
    const rect = timeRulerEl.getBoundingClientRect();
    const width = rect.width || 1;
    const segmentsCount = segments || Math.max(1, Math.round(width));
    const fraction = Math.min(1, Math.max(0, (x - rect.left) / width));

    return { fraction, segmentsCount, rect, width, currentState };
}

function updateRulerSelection(timeRulerEl, x, y) {
    const view = viewByEl.get(timeRulerEl);
    if (!view) {
        return;
    }
    const delta = movingMode === MOVING_TRIGGER ? movingPointerDelta : 0;
    const { fraction, segmentsCount, width } = getRulerFractionForPoint(timeRulerEl, x + delta);
    const hasSelection = timeRulerEl.dataset.state === SELECTION_SELECTED;
    const isSelecting = timeRulerEl.dataset.state === SELECTION_SELECTING;
    const {
        data,
        context,
        render,
        state: currentState,
        duration,
        details
    } = view;

    if (timeRulerEl !== currentViewEl) {
        detailsTooltip.hide();
    }

    if (!hasSelection && !isSelecting) {
        timeRulerEl.dataset.state = SELECTION_HOVERED;
        prevAnchorStart = null;
    }

    const hoverState = movingMode === MOVING_RANGE
        ? moveState(duration, segmentsCount, movingRange, (x - movingPointerDelta) / width)
        : movingMode === MOVING_TRIGGER
            ? resizeState(duration, segmentsCount, prevAnchorStart, fraction)
            : createSelectionState(duration, segmentsCount, prevAnchorStart ?? fraction, fraction);
    const newState = hasSelection
        ? currentState
        : isSelecting
            ? hoverState
            : createState(duration, segmentsCount);

    if (!hasSelection) {
        syncStartEndToDom(timeRulerEl, hoverState.start, hoverState.end);

        if (isSelecting) {
            timeRulerEl.dataset.activeTrigger = movingMode === MOVING_RANGE
                ? 'both'
                : (movingMode === MOVING_TRIGGER ? fraction * duration : fraction) >= prevAnchorStart
                    ? 'finish'
                    : 'start';
        }
    }

    if (details) {
        let displayTooltip = !hasSelection || (fraction >= currentState.start && fraction < currentState.end);
        if (displayTooltip) {
            const tooltipTarget = discovery.dom.root.elementFromPoint(x, y)
                ?.closest('.discovery-view-has-tooltip, .no-view-time-ruler-tooltip');
            if (tooltipTarget && timeRulerEl.parentNode?.contains(tooltipTarget)) {
                displayTooltip = false;
            }
        }
        if (displayTooltip) {
            detailsTooltip.show(timeRulerEl, el =>
                render(el, details, data, { ...context, ...hasSelection ? newState : hoverState })
            );
        } else {
            detailsTooltip.hide();
        }
    }

    setStateIfNeeded(timeRulerEl, newState, false);
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
    if (currentViewEl === null || !viewByEl.has(currentViewEl) || (buttons & 1) === 0) {
        return;
    }

    // move time-ruler in hover mode when no selected range
    if (currentViewEl.dataset.state === SELECTION_SELECTED) {
        const rulerViewEl = currentViewEl; // preserve reference to view element, since it might be changed before pointerup event
        const moverEl = rulerViewEl.querySelector('.view-time-ruler__selection-overlay-mover');
        const { rect, width, currentState } = getRulerFractionForPoint(rulerViewEl, x);

        if (moverEl.contains(target)) {
            switch (target.dataset.trigger) {
                case 'start': {
                    movingMode = MOVING_TRIGGER;
                    movingPointerDelta = rect.left + currentState.start * width - x;
                    prevAnchorStart = currentState.timeEnd;
                    break;
                }

                case 'finish': {
                    movingMode = MOVING_TRIGGER;
                    movingPointerDelta = rect.left + currentState.end * width - x;
                    prevAnchorStart = currentState.timeStart;
                    break;
                }

                default:
                    movingMode = MOVING_RANGE;
                    movingPointerDelta = x;
                    movingRange = { timeStart: currentState.timeStart, timeEnd: currentState.timeEnd };
            }

            startSelectingRange = null;
            rulerViewEl.dataset.state = SELECTION_SELECTING;
            rulerViewEl.setPointerCapture(pointerId);
            rulerViewEl.addEventListener('pointerup', () => {
                if (!viewByEl.has(rulerViewEl)) {
                    return;
                }
                rulerViewEl.releasePointerCapture(pointerId);
                rulerViewEl.dataset.state = SELECTION_SELECTED;
                rulerViewEl.dataset.activeTrigger = 'none';
                movingMode = MOVING_NONE;
            }, { capture: true, once: true });

            return;
        }

        currentViewEl.dataset.state = SELECTION_HOVERED;
    }

    // reset selection state and remenber a selection start point coordinates
    prevAnchorStart = null;
    startSelectingPointerX = x;
    startSelectingPointerY = y;
    updateRulerSelection(currentViewEl, x, y);

    // create a callback on selection start
    startSelectingRange = () => {
        if (!currentViewEl || !viewByEl.has(currentViewEl)) {
            startSelectingRange = null;
            return;
        }
        const { fraction } = getRulerFractionForPoint(currentViewEl, startSelectingPointerX);
        const rulerViewEl = currentViewEl; // preserve reference to view element, since it might be changed before pointerup event

        startSelectingRange = null;
        prevAnchorStart = fraction;
        rulerViewEl.dataset.state = SELECTION_SELECTING;

        rulerViewEl.setPointerCapture(pointerId);
        rulerViewEl.addEventListener('pointerup', () => {
            if (!viewByEl.has(rulerViewEl)) {
                return;
            }
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
        updateRulerSelection(currentViewEl, x, y);
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
        updateRulerSelection(timeRulerEl, x, y);
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
        labels = 'top',
        name = 'ruler',
        details,
        rangeManager,
        onInit,
        onChange
    } = options;
    const line = resolveScopeProfileLine(options.line, context);
    const segments = Number.isFinite(segmentsRaw) && segmentsRaw > 0
        ? Math.max(1, Math.min(Math.floor(segmentsRaw), Math.floor(duration)))
        : null;

    const readRanges = rangeManager && 'ranges' in rangeManager
        ? () => rangeManager.ranges
        : () => (rangeManager?.rangeStart ?? selectionStart) === null ? null : [{
            start: rangeManager?.rangeStart ?? selectionStart,
            end: rangeManager?.rangeEnd ?? selectionEnd
        }];
    // Multiple intervals have no single draggable envelope. A new drag replaces them with one interval.
    const rangeState = ranges => ranges === null ? createState(duration, segments) : ranges.length === 1
        ? createState(duration, segments, ranges[0].start, ranges[0].end)
        : createState(duration, segments, 0, 0);
    const state = rangeState(readRanges());

    syncStateToDom(el, state);

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
        // The coordinate view owns resolve/rebase. Rendering must never write clipped bounds back to the request.
        onChange: onChange || (rangeManager ? state => rangeManager.setRange(state.timeStart, state.timeEnd) : null)
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
        const intervalMarkerEl = el.appendChild(utils.createElement('div'));

        intervalMarkerEl.className = 'interval-marker';
        intervalMarkerEl.style.setProperty('--offset', time / duration);
        intervalMarkerEl.dataset.title = line.type === 'memline'
            ? formatMemory(time, duration)
            : line.type === 'timeline'
                ? formatMicrosecondsTime(time, duration)
                : time;
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

    const rangesEl = el.appendChild(utils.createElement('div', 'view-time-ruler__ranges'));
    const renderRanges = ranges => {
        el.dataset.multipleRanges = String(ranges !== null && ranges.length > 1);
        rangesEl.replaceChildren();

        if (ranges && ranges.length > 1 && duration > 0) {
            for (const range of ranges) {
                const start = Math.max(0, Math.min(duration, range.start));
                const end = Math.max(0, Math.min(duration, range.end));

                if (start < end) {
                    const interval = rangesEl.appendChild(utils.createElement('div'));

                    interval.style.setProperty('left', `${start / duration * 100}%`);
                    interval.style.setProperty('width', `${(end - start) / duration * 100}%`);
                }
            }
        }
    };

    renderRanges(readRanges());

    // call init state callback if any
    if (typeof onInit === 'function') {
        onInit(state, name, el, data, context);
    }

    // subscribe on range changes when range manager is provided
    const subscription = rangeManager?.subscribe(() => {
        const ranges = readRanges();
        setStateIfNeeded(el, rangeState(ranges), true, false);
        renderRanges(ranges);
    });

    // add element for cleanup on destroy
    const destroyEl = utils.createElement('destroy-time-ruler');
    el.appendChild(destroyEl);
    destroyEl.onDestroy = () => {
        subscription?.();
        if (currentViewEl === el) {
            discardCurrentView();
        }
        viewByEl.delete(el);
    };
}, { usage });

class TimeRulerElement extends HTMLElement {
    connectedCallback() {
        this.onConnect?.();
        this.onConnect = null;
    }
    disconnectedCallback() {
        this.onDestroy?.();
        this.onDestroy = null;
    }
}

customElements.define('destroy-time-ruler', TimeRulerElement);
