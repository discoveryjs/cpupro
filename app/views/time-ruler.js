const { utils } = require('@discoveryjs/discovery');
const { formatMicrosecondsTime } = require('../prepare/time-utils.js');

function computeStep(n) {
    let b = 1;

    while (n > 10) {
        b *= 10;
        n = Math.floor(n / 10);
    }

    return n > 5 ? b : n >= 2.5 ? b / 2 : b / 4;
}

let startSelectingRange = null;
let startSelectingX = null;
let currentViewEl = null;
let prevStartSegment = null;
let prevEndSegment = null;
const viewByEl = new WeakMap();
const detailsPopup = new discovery.view.Popup({
    className: 'view-time-ruler-tooltip',
    position: 'pointer',
    positionMode: 'natural',
    pointerOffsetX: 30,
    pointerOffsetY: 15,
    showDelay: 150
});

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

    prevStartSegment = null;
    prevEndSegment = null;
    startSelectingX = x;
    updateRulerSelection(currentViewEl, x);

    startSelectingRange = () => {
        startSelectingRange = null;
        prevStartSegment = segment;
        currentViewEl.dataset.state = 'selecting';

        currentViewEl.setPointerCapture(pointerId);
        currentViewEl.addEventListener('pointerup', () => {
            currentViewEl.releasePointerCapture(pointerId);
            currentViewEl.dataset.state = 'selected';
        }, { capture: true, once: true });
    };
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

    if (timeRulerEl !== currentViewEl) {
        prevStartSegment = null;
        prevEndSegment = null;
        timeRulerEl.style.setProperty('--segments-count', segmentsCount);
        if (timeRulerEl.dataset.state !== 'selected') {
            timeRulerEl.dataset.state = 'hovered';
        }
    }

    if (timeRulerEl.dataset.state === 'selected') {
        return;
    }

    if (segment !== prevEndSegment) {
        const { options, data, context, render } = viewByEl.get(timeRulerEl);
        const startSegment = Math.min(prevStartSegment || segment, segment);
        const endSegment = Math.max(prevStartSegment || segment, segment);
        const segmentDuration = options.duration / segmentsCount;
        const startTime = startSegment * segmentDuration;
        const endTime = (endSegment + 1) * segmentDuration;

        timeRulerEl.style.setProperty('--segment-start', startSegment);
        timeRulerEl.style.setProperty('--segment-end', endSegment);

        prevEndSegment = segment;

        // display tooltip
        detailsPopup.show(timeRulerEl, (el) =>
            render(el, options.details, data, {
                ...context,
                startSegment,
                startTime,
                endSegment,
                endTime
            })
        );
    }
}

utils.pointerXY.subscribe(({ x, y }) => {
    if (startSelectingRange !== null) {
        if (Math.abs(startSelectingX - x) < 2) {
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
    const { duration, captions, details } = options;
    const timeRulerStep = computeStep(duration);

    el.dataset.state = 'none';

    switch (captions) {
        case 'top':
        case 'bottom':
            el.classList.add(`captions-${captions}`);
            break;

        case 'both':
            el.classList.add('captions-top', 'captions-bottom');
            break;
    }

    if (details) {
        viewByEl.set(el, { options, data, context, render: this.render });
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
});
