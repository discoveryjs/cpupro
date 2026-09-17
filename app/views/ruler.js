const { utils } = require('@discoveryjs/discovery');
const { createState, normalizeSelection, selectRange, moveRange, resizeRange, valueAt } = require('./ruler-range.js');
const usage = require('./ruler.usage.js').default;

const SELECTION_NONE = 'none';
const SELECTION_HOVERED = 'hovered';
const SELECTION_SELECTING = 'selecting';
const SELECTION_SELECTED = 'selected';

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

    el.dataset.multipleRanges = String(ranges.length > 1);
    el.dataset.state = gesture?.el === el && gesture.started
        ? SELECTION_SELECTING
        : state.selection === null
            ? SELECTION_NONE
            : SELECTION_SELECTED;

    renderInterval(el, state, ranges.length === 1 ? ranges[0] : null);
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

    const target = discovery.dom.root.elementFromPoint(x, y)
        ?.closest('.discovery-view-has-tooltip, .no-view-ruler-tooltip');

    if (view.details && detail && !(target && el.parentNode?.contains(target))) {
        detailsTooltip.show(el, tooltipEl => view.render(tooltipEl, view.details, view.data, {
            ...view.context, ruler: view.state, detail
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
                const startTrigger = state.segments
                    ? fraction < gesture.anchor
                    : detail.start < anchorValue;

                detail = state.segments
                    ? selectRange(state, gesture.anchor, fraction)
                    : resizeRange(state, anchorValue, fraction, minimum, direction);
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
        details,
        onInit,
        onChange,
        onCommit
    } = options;
    const state = createState(range, segments, selection, multiple);
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
    } };

    // apply interval marker labels position if any
    el.dataset.labels = ['top', 'bottom', 'both'].includes(labels)
        ? labels
        : 'none';
    el.dataset.grid = String(grid);

    // draw interval markers
    const rulerStep = computeStep(state.length);
    if (grid || el.dataset.labels !== 'none') {
        for (
            let offset = 0;
            offset < state.length - rulerStep / 10;
            offset += rulerStep
        ) {
            const intervalMarkerEl = el.appendChild(utils.createElement('div'));

            intervalMarkerEl.className = 'interval-marker';
            intervalMarkerEl.style.setProperty('--offset', offset / state.length);
            intervalMarkerEl.dataset.title = formatLabel(state.range.start + offset, state.range);
        }
    }

    // overlay element
    el.appendChild(
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
    const view = { state, api, data, context, multiple, details, onChange, onCommit, rangesEl, render: this.render };

    viewByEl.set(el, view);
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
