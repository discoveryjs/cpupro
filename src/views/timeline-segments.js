discovery.view.define('timeline-segments', function(el, config, data, context) {
    if (!Array.isArray(data)) {
        data = [];
    }

    const total = context.data.totalTime;
    for (const [offset, duration] of data) {
        const segmentEl = document.createElement('div');

        segmentEl.className = 'timeline-segment';
        segmentEl.style.setProperty('--offset', (offset / total).toFixed(8));
        segmentEl.style.setProperty('--width', (duration / total).toFixed(8));

        el.appendChild(segmentEl);
    }
});
