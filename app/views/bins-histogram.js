import { utils } from '@discoveryjs/discovery';
import { drawBinsHistogram } from './bins-histogram/index.js';
import usage from './bins-histogram.usage.js';

function ensureArray(value) {
    return utils.isArray(value) ? value : [];
}

discovery.view.define('bins-histogram', function(el, config, data, context) {
    const options = {
        bins: ensureArray(config.bins || data),
        range: config.range,
        viewport: config.viewport,
        presence: config.presence,
        peaks: config.peaks,
        max: config.max,
        scaleBins: config.scaleBins,
        scaleMax: config.scaleMax,
        binsMax: config.binsMax,
        scale: config.scale // 'linear', 'log', 'sqrt'
    };
    const canvasEl = utils.createElement('canvas');
    const destroyEl = utils.createElement('destroy-bins-histogram');
    const ctx = canvasEl.getContext('2d');
    const height = config.height || 20;
    const api = {
        setViewport(viewport) {
            options.viewport = viewport;

            // Until the canvas is sized its first draw is pending anyway, a skipped one is drawn when shown
            if (skipped) {
                stale = true;
            } else if (scheduledDraw === null && dpr !== undefined) {
                scheduledDraw = requestAnimationFrame(draw);
            }
        }
    };
    const resizeObserver = new ResizeObserver(([entry]) => {
        dpr = window.devicePixelRatio || 1;
        color = getComputedStyle(el).getPropertyValue('--color') || '#888';
        canvasEl.width = Math.round(entry.contentRect.width * dpr);
        canvasEl.height = Math.round(height * dpr);
        draw();
    });
    let scheduledDraw = null;
    let skipped = false;
    let stale = false;
    let cleanup = null;
    let color;
    let dpr;

    function draw() {
        cancelAnimationFrame(scheduledDraw);
        scheduledDraw = null;
        drawBinsHistogram(ctx, options, color, dpr);
    }

    if (config.color) {
        el.style.setProperty('--color', config.color);
    }

    canvasEl.style.height = height + 'px';

    // A histogram out of view skips its contents (content-visibility), so it's neither painted nor drawn: on a page of
    // hundreds of rows every frame would layerize their canvases and draw them
    el.style.containIntrinsicHeight = `auto ${height}px`;
    el.addEventListener('contentvisibilityautostatechange', event => {
        skipped = event.skipped;

        if (!skipped && stale && dpr !== undefined) {
            stale = false;
            draw();
        }
    });
    destroyEl.onConnect = () => {
        resizeObserver.observe(canvasEl);
        cleanup = config.onInit?.(api, data, context);
    };
    destroyEl.onDestroy = () => {
        resizeObserver.disconnect();
        cancelAnimationFrame(scheduledDraw);
        cleanup?.();
    };
    el.append(canvasEl, destroyEl);
}, { usage });

class BinsHistogramElement extends HTMLElement {
    connectedCallback() {
        this.onConnect();
        this.onConnect = null;
    }
    disconnectedCallback() {
        this.onDestroy();
        this.onDestroy = null;
    }
}

customElements.define('destroy-bins-histogram', BinsHistogramElement);
