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

function createNullState() {
    return {
        segmentStart: null,
        segmentEnd: null,
        timeStart: null,
        timeEnd: null
    };
}

function timeToSegment(time = null, duration, segments) {
    return time === null ? null : Math.floor((time / duration) * (segments - 1));
}

function createStateFromState({ duration, segments }, timeStart = null, timeEnd = null) {
    const segmentStart = timeToSegment(timeStart, duration, segments);
    const segmentEnd = timeToSegment(timeEnd, duration, segments);

    return {
        duration,
        segments,
        segmentStart,
        segmentEnd,
        timeStart,
        timeEnd
    };
}

function createState(duration, segments, selectionStart, selectionEnd) {
    return createStateFromState({ duration, segments }, selectionStart, selectionEnd);
}

let startSelectingRange = null;
let startSelectingPointerX = null;
let prevSegmentStart = null;
let prevSegmentEnd = null;
let currentViewEl = null;
const viewByEl = new WeakMap();
const detailsPopup = new discovery.view.Popup({
    className: 'view-time-ruler-tooltip',
    position: 'pointer',
    positionMode: 'natural',
    pointerOffsetX: 30,
    pointerOffsetY: 15,
    showDelay: 100
});

function getRulerSegmentForPoint(timeRulerEl, x) {
    const { options } = viewByEl.get(timeRulerEl);
    const rect = timeRulerEl.getBoundingClientRect();
    const width = timeRulerEl.clientWidth - 2;
    const segmentsCount = options.segments || width;
    const fraction = Math.min(width, Math.max(0, x - rect.left)) / width;
    const segment = Math.floor(fraction * (segmentsCount - 1));

    return { segment, segmentsCount };
}

function updateRulerSelection(timeRulerEl, x) {
    const { segment, segmentsCount } = getRulerSegmentForPoint(timeRulerEl, x);
    const { options, data, context, render, state: currentState } = viewByEl.get(timeRulerEl);

    if (timeRulerEl !== currentViewEl) {
        timeRulerEl.style.setProperty('--segments-count', segmentsCount);

        if (timeRulerEl.dataset.state !== 'selected') {
            prevSegmentStart = null;
            prevSegmentEnd = null;
            timeRulerEl.dataset.state = 'hovered';
        } else {
            prevSegmentStart = timeToSegment(currentState.timeStart, currentState.duration, segmentsCount);
            prevSegmentEnd = timeToSegment(currentState.timeEnd, currentState.duration, segmentsCount);
        }
    }

    if (timeRulerEl.dataset.state === 'selected') {
        return;
    }

    if (segment !== prevSegmentEnd) {
        const segmentStart = Math.min(prevSegmentStart !== null ? prevSegmentStart : segment, segment);
        const segmentEnd = Math.max(prevSegmentStart !== null ? prevSegmentStart : segment, segment);
        const segmentDuration = options.duration / segmentsCount;
        const timeStart = segmentStart * segmentDuration | 0;
        const timeEnd = (segmentEnd + 1) * segmentDuration | 0;
        const newState = prevSegmentStart !== null
            ? createStateFromState(currentState, timeStart, timeEnd)
            : createStateFromState(currentState);

        prevSegmentEnd = segment;

        timeRulerEl.style.setProperty('--segment-start', segmentStart);
        timeRulerEl.style.setProperty('--segment-end', segmentEnd);

        // display tooltip
        if (options.details) {
            detailsPopup.show(timeRulerEl, (el) =>
                render(el, options.details, data, {
                    ...context,
                    ...currentState
                })
            );
        }

        // update state if needed
        if (!utils.equal(newState, currentState)) {
            Object.assign(currentState, newState);

            if (typeof options.onChange === 'function') {
                options.onChange(timeRulerEl, newState, data, context);
            }
        }
    }
}

discovery.addGlobalEventListener('pointerup', () => {
    startSelectingRange = null;
});
discovery.addHostElEventListener('pointerdown', ({ buttons, pointerId, x }) => {
    if (currentViewEl === null || (buttons & 1) === 0) {
        return;
    }

    const { segment } = getRulerSegmentForPoint(currentViewEl, x);

    if (currentViewEl.dataset.state === 'selected') {
        currentViewEl.dataset.state = 'hovered';
    }

    prevSegmentStart = null;
    prevSegmentEnd = null;
    startSelectingPointerX = x;
    updateRulerSelection(currentViewEl, x);

    startSelectingRange = () => {
        startSelectingRange = null;
        prevSegmentStart = segment;
        currentViewEl.dataset.state = 'selecting';

        currentViewEl.setPointerCapture(pointerId);
        currentViewEl.addEventListener('pointerup', () => {
            currentViewEl.releasePointerCapture(pointerId);
            currentViewEl.dataset.state = 'selected';
        }, { capture: true, once: true });
    };
});

utils.pointerXY.subscribe(({ x, y }) => {
    if (startSelectingRange !== null) {
        if (Math.abs(startSelectingPointerX - x) < 2) {
            return;
        }

        startSelectingRange();
    }

    if (currentViewEl?.dataset.state === 'selecting') {
        updateRulerSelection(currentViewEl, x);
        return;
    }

    const elementsFromPoint = discovery.dom.root.elementsFromPoint(x, y);
    const candidateEl = elementsFromPoint.find(el => viewByEl.has(el)) || null;

    // check for closest element to cursor is in a subtree of the common parent,
    // this excludes displaying a details popup when the cursor is over another popup or sticky element (e.g. page-header)
    const timeRulerEl = candidateEl && candidateEl.parentNode.contains(elementsFromPoint[0])
        ? candidateEl
        : null;

    // register time-ruler element is found and met all the conditions
    if (timeRulerEl) {
        updateRulerSelection(timeRulerEl, x);
    } else if (currentViewEl) {
        detailsPopup.hide();

        if (currentViewEl.dataset.state !== 'selected') {
            currentViewEl.dataset.state = 'none';
        }
    }

    currentViewEl = timeRulerEl;
});

discovery.view.define('time-ruler', function(el, options, data, context) {
    const {
        duration,
        segments,
        selectionStart,
        selectionEnd,
        captions = 'top',
        onInit
    } = options;
    const timeRulerStep = computeStep(duration);
    const state = createState(duration, segments, selectionStart, selectionEnd);

    viewByEl.set(el, { options, data, context, state, render: this.render });

    if (state.segmentStart !== null) {
        el.dataset.state = 'selected';
        el.style.setProperty('--segments-count', state.segments);
        el.style.setProperty('--segment-start', state.segmentStart);
        el.style.setProperty('--segment-end', state.segmentEnd);
    } else {
        el.dataset.state = 'none';
    }

    switch (captions) {
        case 'top':
        case 'bottom':
            el.classList.add(`captions-${captions}`);
            break;

        case 'both':
            el.classList.add('captions-top', 'captions-bottom');
            break;
    }

    const selectionOverlayEl = el.appendChild(document.createElement('div'));
    selectionOverlayEl.className = 'view-time-ruler__selection-overlay';

    for (
        let time = 0;
        time < duration - timeRulerStep / 10;
        time += timeRulerStep
    ) {
        const lineEl = el.appendChild(document.createElement('div'));

        lineEl.className = 'line';
        lineEl.style.setProperty('--offset', time / duration);
        lineEl.dataset.title = formatMicrosecondsTime(time, duration);
    }

    if (typeof onInit === 'function') {
        onInit(el, state, data, context);
    }
}, { usage });
