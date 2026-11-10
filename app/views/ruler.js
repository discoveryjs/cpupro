const { utils } = require('@discoveryjs/discovery');
const { createState, normalizeRange, normalizeSelection, selectRange, moveRange, resizeRange, zoomRange, panRange, valueAt } = require('./ruler-range.js');
const usage = require('./ruler.usage.js').default;

const SELECTION_NONE = 'none';
const SELECTION_HOVERED = 'hovered';
const SELECTION_SELECTING = 'selecting';
const SELECTION_SELECTED = 'selected';
// The same wheel gesture scale as the track timeline
const WHEEL_ZOOM_SPEED = 0.0015;

const viewByEl = new WeakMap();
const detailsTooltip = new discovery.view.Popup({
    className: 'view-ruler-tooltip',
    position: 'pointer',
    positionMode: 'natural',
    pointerOffsetX: 30,
    pointerOffsetY: 15,
    showDelay: 100
});

let gesture = null;
let currentViewEl = null;

function computeStep(n) {
    let b = 1;

    while (n > 0 && n < 1) {
        b /= 10;
        n *= 10;
    }

    while (n > 10) {
        b *= 10;
        n = Math.floor(n / 10);
    }

    return n > 5 ? b : n >= 2.5 ? b / 2 : b / 4;
}

function selectionRanges(view) {
    const { selection } = view.state;
    return selection === null ? [] : view.multiple ? selection : [selection];
}

function fractionAt(state, value) {
    return state.length > 0 ? Math.max(0, Math.min(1, (value - state.range.start) / state.length)) : 0;
}

function renderInterval(el, state, range) {
    el.style.setProperty('--selection-start', range ? fractionAt(state, range.start) : 0);
    el.style.setProperty('--selection-end', range ? fractionAt(state, range.end) : 0);
}

function renderSelection(el, view) {
    const { state } = view;
    const ranges = selectionRanges(view);
    const singleRange = ranges.length === 1
        ? ranges[0]
        : null;

    el.dataset.multipleRanges = String(ranges.length > 1);
    el.dataset.state = gesture?.el === el && gesture.started
        ? SELECTION_SELECTING
        : state.selection === null
            ? SELECTION_NONE
            : SELECTION_SELECTED;

    renderInterval(el, state, singleRange);
    // A selection out of the ruler range, e.g. of a zoomed one, leaves all of the ruler dimmed without its edges
    el.dataset.selectionInRange = String(
        singleRange !== null && fractionAt(state, singleRange.start) < fractionAt(state, singleRange.end)
    );
    view.rangesEl.replaceChildren();

    if (ranges.length > 1) {
        for (const range of ranges) {
            const start = fractionAt(state, range.start);
            const end = fractionAt(state, range.end);

            if (start < end) {
                const interval = view.rangesEl.appendChild(utils.createElement('div'));
                interval.style.setProperty('left', `${start * 100}%`);
                interval.style.setProperty('width', `${(end - start) * 100}%`);
            }
        }
    }
}

function renderMarkers(el, view) {
    const { state, formatLabel, markers } = view;
    const rulerStep = computeStep(state.length);
    // Markers of a zoomed range keep the steps of its bounds
    const origin = view.bounds?.start ?? state.range.start;
    const firstStep = Math.ceil((state.range.start - origin) / rulerStep);
    let count = 0;

    if (view.grid || el.dataset.labels !== 'none') {
        for (
            let value = origin + firstStep * rulerStep, index = firstStep;
            value < state.range.end - rulerStep / 10;
            value = origin + ++index * rulerStep
        ) {
            // PERF: Markers are reused while zooming, since an insertion may restyle the whole document
            // (e.g. under a :has() rule of an ancestor)
            if (count === markers.length) {
                markers.push(el.insertBefore(utils.createElement('div', 'interval-marker'), view.overlayEl));
            }

            markers[count].hidden = false;
            markers[count].style.setProperty('--offset', (value - state.range.start) / state.length);
            markers[count].dataset.title = formatLabel(value, state.range, rulerStep);
            count++;
        }
    }

    for (let i = count; i < markers.length; i++) {
        markers[i].hidden = true;
    }
}

// Segments may depend on the range and the width of the ruler, e.g. columns of a histogram
function resolveSegments(segments, range, width) {
    return typeof segments === 'function'
        ? segments(normalizeRange(range), width)
        : segments;
}

function updateSegments(el, view) {
    const width = el.getBoundingClientRect().width;

    if (typeof view.segments === 'function' && width !== view.width) {
        const { state } = view;

        view.width = width;
        state.segments = createState(state.range, resolveSegments(view.segments, state.range, width)).segments;
    }
}

function updateRange(el, range, notify = false) {
    const view = viewByEl.get(el);

    if (!view) {
        return;
    }

    const { state } = view;
    const next = createState(range, resolveSegments(view.segments, range, view.width), state.selection, view.multiple);

    if (next.range.start !== state.range.start || next.range.end !== state.range.end) {
        Object.assign(state, next);
        renderMarkers(el, view);
        renderSelection(el, view);
        detailsTooltip.hide();

        if (notify) {
            view.onRangeChange?.(view.api, view.data, view.context);
        }
    }
}

function updateSelection(el, selection, notify = false) {
    const view = viewByEl.get(el);

    if (!view) {
        return;
    }

    const next = normalizeSelection(selection, view.multiple);

    if (!utils.deepEqual(view.state.selection, next)) {
        view.state.selection = next;
        renderSelection(el, view);

        if (notify) {
            view.onChange?.(view.api, view.data, view.context);
        }
    }
}

function clearGesture() {
    const previous = gesture;

    gesture = null;

    if (previous) {
        previous.el.dataset.activeTrigger = 'none';

        if (previous.el.hasPointerCapture(previous.pointerId)) {
            previous.el.releasePointerCapture(previous.pointerId);
        }
    }

    return previous;
}

function cancelGesture() {
    const previous = clearGesture();

    if (previous && viewByEl.has(previous.el)) {
        updateSelection(previous.el, previous.original, true);
        renderSelection(previous.el, viewByEl.get(previous.el));
    }

    detailsTooltip.hide();
}

function discardCurrentView() {
    detailsTooltip.hide();

    if (currentViewEl && viewByEl.has(currentViewEl)) {
        renderSelection(currentViewEl, viewByEl.get(currentViewEl));
    }

    currentViewEl = null;
}

function getRulerFractionForPoint(el, x) {
    const rect = el.getBoundingClientRect();

    return Math.max(0, Math.min(1, (x - rect.left) / (rect.width || 1)));
}

function showDetails(el, detail, x, y) {
    const view = viewByEl.get(el);

    if (!view) {
        return;
    }

    const elements = discovery.dom.root.elementsFromPoint(x, y);
    const suppress = elements[0]?.closest('.discovery-view-has-tooltip, .no-view-ruler-tooltip');
    const target = elements.find(target => !el.contains(target) && el.parentNode?.contains(target));

    if (view.details && detail && !(suppress && el.parentNode?.contains(suppress))) {
        detailsTooltip.show(el, tooltipEl => view.render(tooltipEl, view.details, view.data, {
            ...view.context,
            ruler: view.state,
            detail,
            detailTarget: target
        }));
    } else {
        detailsTooltip.hide();
    }
}

function updatePointer(el, x, y) {
    const view = viewByEl.get(el);

    if (!view || view.state.length <= 0) {
        return;
    }

    updateSegments(el, view);

    const { state } = view;
    const fraction = getRulerFractionForPoint(el, x);
    let detail;

    if (gesture?.el === el && gesture.started) {
        const width = el.getBoundingClientRect().width || 1;
        const minimum = state.length / width;
        const direction = el.dataset.activeTrigger === 'start' ? -1 : 1;
        let activeTrigger;

        switch (gesture.mode) {
            case 'move':
                detail = moveRange(state, gesture.range, (x - gesture.x) / width);
                activeTrigger = 'both';
                break;

            case 'resize':
                detail = resizeRange(state, gesture.anchor, getRulerFractionForPoint(el, x + gesture.offset), minimum, direction);
                activeTrigger = detail.start < gesture.anchor
                    ? 'start'
                    : 'finish';
                break;

            default: {
                const anchorValue = valueAt(state, gesture.anchor);

                detail = state.segments
                    ? selectRange(state, gesture.anchor, fraction)
                    : resizeRange(state, anchorValue, fraction, minimum, direction);
                const startTrigger = state.segments
                    ? fraction < gesture.anchor
                    : detail.start < anchorValue;
                activeTrigger = startTrigger
                    ? 'start'
                    : 'finish';
            }
        }

        el.dataset.activeTrigger = activeTrigger;
        updateSelection(el, view.multiple ? [detail] : detail, true);
    } else if (state.selection !== null) {
        const value = valueAt(state, fraction);

        detail = selectionRanges(view).find(range => value >= range.start && value < range.end);

        if (detail) {
            detail = {
                start: Math.max(state.range.start, detail.start),
                end: Math.min(state.range.end, detail.end)
            };
        }
    } else {
        detail = selectRange(state, fraction, fraction);
        el.dataset.state = SELECTION_HOVERED;
        renderInterval(el, state, detail);
    }

    showDetails(el, detail, x, y);
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
discovery.addGlobalEventListener('pointerleave', () => {
    if (!gesture?.started) {
        cancelGesture();
        discardCurrentView();
    }
}, true);

// track pointer pointer buttons
discovery.addGlobalEventListener('pointerup', (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
    }

    if (gesture.started) {
        updatePointer(gesture.el, event.x, event.y);
    }

    const previous = clearGesture();
    const view = previous && viewByEl.get(previous.el);

    if (!view) {
        return;
    }

    if (!previous.started && view.state.selection !== null) {
        updateSelection(previous.el, null, true);
    }

    renderSelection(previous.el, view);

    if (previous.started || previous.original !== null) {
        view.onCommit?.(view.api, view.data, view.context);
    }
}, true);
discovery.addGlobalEventListener('pointercancel', cancelGesture, true);
discovery.addGlobalEventListener('keydown', event => {
    if (event.key === 'Escape' && gesture) {
        event.preventDefault();
        cancelGesture();
    }
}, true);
discovery.addHostElEventListener('pointerdown', ({ buttons, pointerId, x, y, target }) => {
    // do nothing when not over a ruler element or not a main button is pressed
    if (currentViewEl === null || !viewByEl.has(currentViewEl) || (buttons & 1) === 0) {
        return;
    }

    const el = currentViewEl;
    const view = viewByEl.get(el);

    if (view.state.length <= 0) {
        return;
    }

    const ranges = selectionRanges(view);
    const mover = el.querySelector('.view-ruler__selection-overlay-mover');
    const editing = ranges.length === 1 && mover.contains(target);
    const range = editing ? {
        start: Math.max(view.state.range.start, ranges[0].start),
        end: Math.min(view.state.range.end, ranges[0].end)
    } : null;
    const trigger = editing ? target.dataset.trigger : null;
    const rect = el.getBoundingClientRect();

    gesture = {
        el, pointerId, x, y, range, original: view.state.selection,
        mode: editing ? trigger ? 'resize' : 'move' : 'select',
        anchor: editing ? trigger === 'start' ? range.end : range.start : getRulerFractionForPoint(el, x),
        offset: trigger ? rect.left + fractionAt(view.state, trigger === 'start' ? range.start : range.end) * rect.width - x : 0,
        started: editing
    };

    if (editing) {
        el.dataset.activeTrigger = trigger || 'both';
        el.setPointerCapture(pointerId);
        renderSelection(el, view);
    }
});

// zoom with a pinch or Ctrl/Cmd + wheel, and pan with a horizontal wheel, when the ruler has bounds;
// a vertical wheel keeps scrolling the page
discovery.addHostElEventListener('wheel', (event) => {
    const zoom = event.ctrlKey || event.metaKey;

    if (gesture || (!zoom && Math.abs(event.deltaX) <= Math.abs(event.deltaY))) {
        return;
    }

    // The ruler under the pointer may have been replaced since the pointer moved
    const el = discovery.dom.root.elementsFromPoint(event.x, event.y).find(el => viewByEl.has(el));
    const view = el && viewByEl.get(el);

    if (!view?.bounds) {
        return;
    }

    const { state, bounds } = view;
    const width = el.getBoundingClientRect().width || 1;
    // A pixel can't resolve a range finer than the precision of its coordinates
    const precision = Number.EPSILON * Math.max(1, Math.abs(bounds.start), Math.abs(bounds.end));
    const range = zoom
        ? zoomRange(state.range, bounds, getRulerFractionForPoint(el, event.x), Math.exp(event.deltaY * WHEEL_ZOOM_SPEED), width * precision)
        : panRange(state.range, bounds, event.deltaX / width);

    event.preventDefault();
    updateRange(el, range, true);
}, { passive: false });

// thack pointer to determine the pointer is over a ruler;
// using such an approach since ruler might be overlaped by another content
utils.pointerXY.subscribe(({ x, y }) => {
    if (gesture) {
        if (!gesture.started && Math.abs(gesture.x - x) < 2 && Math.abs(gesture.y - y) < 2) {
            return;
        }

        if (!gesture.started) {
            gesture.started = true;
            gesture.el.setPointerCapture(gesture.pointerId);
            renderSelection(gesture.el, viewByEl.get(gesture.el));
        }

        updatePointer(gesture.el, x, y);
        return;
    }

    // get ruler element candidate under the pointer
    const elementsFromPoint = discovery.dom.root.elementsFromPoint(x, y);
    const candidateEl = elementsFromPoint.find(el => viewByEl.has(el)) || null;

    // check for closest element to cursor is in a subtree of the common parent,
    // this excludes displaying a details popup when the cursor is over another popup or sticky element (e.g. page-header)
    const rulerEl = candidateEl?.parentNode.contains(elementsFromPoint[0])
        ? candidateEl
        : null;

    // update ruler selection when its element is found and met all the conditions
    if (rulerEl) {
        if (currentViewEl !== rulerEl) {
            discardCurrentView();
        }

        updatePointer(rulerEl, x, y);
    } else if (currentViewEl) {
        // there is no ruler element under the pointer that met the conditions,
        // but we had such previously, so hide its details popup and reset the state if needed
        discardCurrentView();
    }

    // remember ruler element as current if any
    currentViewEl = rulerEl;
});

discovery.view.define('ruler', function(el, options, data, context) {
    const {
        range,
        segments = null,
        selection = null,
        multiple = false,
        grid = true,
        labels = 'top',
        formatLabel = String,
        name = 'ruler',
        bounds = null,
        details,
        onInit,
        onChange,
        onRangeChange,
        onCommit
    } = options;
    const width = el.getBoundingClientRect().width;
    const state = createState(range, resolveSegments(segments, range, width), selection, multiple);
    const api = { state, name, el, setSelection(selection) {
        if (viewByEl.has(el)) {
            const next = normalizeSelection(selection, multiple);
            if (!utils.deepEqual(state.selection, next)) {
                if (gesture?.el === el) {
                    clearGesture();
                }
                updateSelection(el, next);
                detailsTooltip.hide();
            }
        }
    }, setRange(range) {
        updateRange(el, range);
    } };

    // apply interval marker labels position if any
    el.dataset.labels = ['top', 'bottom', 'both'].includes(labels)
        ? labels
        : 'none';
    el.dataset.grid = String(grid);

    // overlay element
    const overlayEl = el.appendChild(
        utils.createElement('div', 'view-ruler__selection-overlay', [
            utils.createElement('div', 'view-ruler__selection-overlay-mover', [
                utils.createElement('div', {
                    class: 'view-ruler__selection-overlay-mover-trigger',
                    'data-trigger': 'start'
                }),
                utils.createElement('div', {
                    class: 'view-ruler__selection-overlay-mover-trigger',
                    'data-trigger': 'finish'
                })
            ])
        ])
    );

    const rangesEl = el.appendChild(utils.createElement('div', 'view-ruler__ranges'));
    const view = {
        state, api, data, context, multiple, segments, width, grid, formatLabel, markers: [], overlayEl,
        bounds: bounds && normalizeRange(bounds),
        details, onChange, onRangeChange, onCommit, rangesEl, render: this.render
    };

    viewByEl.set(el, view);
    renderMarkers(el, view);
    renderSelection(el, view);

    // add element for cleanup on destroy
    const destroyEl = utils.createElement('destroy-ruler');
    el.appendChild(destroyEl);
    let cleanup;
    destroyEl.onDestroy = () => {
        if (!viewByEl.has(el)) {
            return;
        }

        if (gesture?.el === el) {
            clearGesture();
        }

        if (currentViewEl === el) {
            discardCurrentView();
        }

        viewByEl.delete(el);

        if (typeof cleanup === 'function') {
            cleanup();
        }
    };
    cleanup = onInit?.(api, data, context);
}, { usage });

class RulerElement extends HTMLElement {
    connectedCallback() {
        this.onConnect?.();
        this.onConnect = null;
    }
    disconnectedCallback() {
        this.onDestroy?.();
        this.onDestroy = null;
    }
}

customElements.define('destroy-ruler', RulerElement);
