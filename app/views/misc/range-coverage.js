export function setRangeCoverage(el, extent, viewport) {
    const duration = viewport.end - viewport.start;
    const start = duration > 0 ? (extent.start - viewport.start) / duration : 0;
    const end = duration > 0 ? (viewport.end - extent.end) / duration : 1;

    console.log('coverage', {start, end});

    el.classList.add('range-coverage');
    el.style.setProperty('--range-pad-start', Math.max(0, Math.min(1, start)));
    el.style.setProperty('--range-pad-end', Math.max(0, Math.min(1, end)));
}
