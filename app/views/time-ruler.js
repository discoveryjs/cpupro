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

const viewByEl = new WeakMap();
let prevViewEl = null;
let prevStartSegment = null;
let prevEndSegment = null;
const detailsPopup = new discovery.view.Popup({
    className: 'view-time-ruler-tooltip',
    position: 'pointer',
    positionMode: 'natural',
    pointerOffsetX: 30,
    pointerOffsetY: 15,
    showDelay: 150
});

utils.pointerXY.subscribe(({ x, y }) => {
    const elementsFromPoint = discovery.dom.root.elementsFromPoint(x, y);
    const candidateEl = elementsFromPoint.find(el => viewByEl.has(el)) || null;

    // check for closest element to cursor is in a subtree of the common parent,
    // this excludes displaying a details popup when the cursor is over another popup or sticky element (e.g. page-header)
    const timeRulerEl = candidateEl && candidateEl.parentNode.contains(elementsFromPoint[0])
        ? candidateEl
        : null;

    // register time-ruler element is found and met all the conditions
    if (timeRulerEl) {
        const rect = timeRulerEl.getBoundingClientRect();
        const { options, data, context, render } = viewByEl.get(timeRulerEl);
        const width = timeRulerEl.clientWidth;
        const segmentsCount = options.segments || width;
        const segment = Math.floor((Math.max(0, x - rect.left) / width) * segmentsCount);

        // console.log(
        //     { x, l: rect.x + width },
        //     (Math.max(0, x - rect.left) / width),
        //     segmentsCount,
        //     segment,
        //     '/',
        //     Math.min(prevStartSegment || prevEndSegment, prevEndSegment)
        // );

        // console.log(x, y, timeRulerEl, options, rect);

        if (timeRulerEl !== prevViewEl) {
            timeRulerEl.classList.add('hovered');
            timeRulerEl.style.setProperty('--segments-count', segmentsCount);
            prevStartSegment = null;
            prevEndSegment = null;
        }

        if (segment !== prevEndSegment) {
            const startSegment = Math.min(prevStartSegment || segment, segment);
            const endSegment = Math.max(prevStartSegment || segment, segment);
            // const startTime = 

            timeRulerEl.style.setProperty('--segment', segment);
            prevEndSegment = segment;

            detailsPopup.show(timeRulerEl, (el) =>
                render(el, options.details, data, {
                    ...context,
                    startSegment,
                    endSegment
                })
            );
        }
    } else if (prevViewEl) {
        prevViewEl.classList.remove('hovered');
        detailsPopup.hide();
    }

    prevViewEl = timeRulerEl;
});

discovery.view.define('time-ruler', function(el, options, data, context) {
    const { duration, captions, details } = options;
    const timeRulerStep = computeStep(duration);

    if (details) {
        viewByEl.set(el, { options, data, context, render: this.render });
    }

    switch (captions) {
        case 'top':
        case 'bottom':
            el.classList.add(captions);
            break;

        case 'both':
            el.classList.add('top', 'bottom');
            break;
    }

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
