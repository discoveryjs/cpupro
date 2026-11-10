import { utils } from '@discoveryjs/discovery';
import { resolveScopeProfileLine } from '../jora/profile.js';
import { lineZoom, subscribeLineZoom } from '../jora/viewport.js';
import { min, max } from '../prepare/misc/utils.js';
import { chartScaleY, drawChart } from './chart/index.js';
import { setRangeCoverage } from './misc/range-coverage.js';
import usage from './chart.usage.js';

discovery.view.define('cpupro-chart', function(el, config, data, context) {
    const points = ensureArray(config.points || data);
    const series = toSeries(points);
    const total = toSeries(ensureArray(config.pointsTotal));
    // Spreading values into Math.min() and Math.max() overflows the stack on long series
    const minY = config.minY ?? min(series.y);
    const maxY = config.maxY ?? max(series.y.concat(total.y));
    const minX = config.minX ?? series.x[0];
    const maxX = config.maxX ?? series.x.at(-1);
    const height = config.height || 150;
    const options = {
        series,
        total,
        extent: config.extent || { start: minX, end: maxX },
        viewport: { start: minX, end: maxX },
        scaleY: chartScaleY(minY, maxY, height)
    };
    const canvasEl = utils.createElement('canvas');
    const destroyEl = utils.createElement('destroy-cpupro-chart');
    const ctx = canvasEl.getContext('2d');
    const resizeObserver = new ResizeObserver(([entry]) => {
        dpr = window.devicePixelRatio || 1;
        color = getComputedStyle(el).getPropertyValue('--color') || '#888';
        canvasEl.width = Math.round(entry.contentRect.width * dpr);
        canvasEl.height = Math.round(height * dpr);
        draw();
    });
    let unsubscribe = null;
    let scheduledDraw = null;
    let color;
    let dpr;

    function draw() {
        cancelAnimationFrame(scheduledDraw);
        scheduledDraw = null;
        drawChart(ctx, options, color, dpr);
    }

    if (config.color) {
        el.style.setProperty('--color', config.color);
    }

    setRangeCoverage(el, options.extent, options.viewport);
    canvasEl.style.height = height + 'px';

    // With zoom the chart displays the line zoom, otherwise the range of minX and maxX
    destroyEl.onConnect = () => {
        resizeObserver.observe(canvasEl);

        if (config.zoom) {
            const line = resolveScopeProfileLine(config.line, context);
            const profiles = context.data?.profiles;
            const followZoom = () => {
                options.viewport = lineZoom(line, profiles);
                setRangeCoverage(el, options.extent, options.viewport);

                // Until the canvas is sized its first draw is pending anyway
                if (scheduledDraw === null && dpr !== undefined) {
                    scheduledDraw = requestAnimationFrame(draw);
                }
            };

            unsubscribe = subscribeLineZoom(line, followZoom);
            followZoom();
        }
    };
    destroyEl.onDestroy = () => {
        resizeObserver.disconnect();
        cancelAnimationFrame(scheduledDraw);
        unsubscribe?.();
    };

    el.append(...generateYLabels(options.scaleY.ticks, config.labelFormat), canvasEl, destroyEl);
}, { usage });

function ensureArray(value) {
    return Array.isArray(value) ? value : [];
}

function toSeries(points) {
    return {
        x: points.map(p => p.x ?? p[0]),
        y: points.map(p => p.y ?? p[1])
    };
}

function generateYLabels(ticks, formatFn = (v) => v.toFixed(2)) {
    const labels = [];

    for (const { y, value } of ticks) {
        const labelEl = document.createElement('span');

        labelEl.classList.add('y-tick-label');
        labelEl.style.setProperty('--top', `${y}px`);
        labelEl.textContent = formatFn(value);

        labels.push(labelEl);
    }

    return labels;
}

class ChartElement extends HTMLElement {
    connectedCallback() {
        this.onConnect();
        this.onConnect = null;
    }
    disconnectedCallback() {
        this.onDestroy();
        this.onDestroy = null;
    }
}

customElements.define('destroy-cpupro-chart', ChartElement);
