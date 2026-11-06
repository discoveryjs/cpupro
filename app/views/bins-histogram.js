import { utils } from '@discoveryjs/discovery';
import { drawBinsHistogram } from './bins-histogram/index.js';

function ensureArray(value) {
    return utils.isArray(value) ? value : [];
}

discovery.view.define('bins-histogram', function(el, config, data) {
    const options = {
        bins: ensureArray(config.bins || data),
        presence: config.presence,
        max: config.max,
        binsMax: config.binsMax,
        scale: config.scale // 'linear', 'log', 'sqrt'
    };
    const canvasEl = utils.createElement('canvas');
    const destroyEl = utils.createElement('destroy-bins-histogram');
    const ctx = canvasEl.getContext('2d');
    const height = config.height || 20;
    const resizeObserver = new ResizeObserver(([entry]) => {
        const dpr = window.devicePixelRatio || 1;

        canvasEl.width = Math.round(entry.contentRect.width * dpr);
        canvasEl.height = Math.round(height * dpr);
        drawBinsHistogram(ctx, options, getComputedStyle(el).getPropertyValue('--color') || '#888', dpr);
    });

    if (config.color) {
        el.style.setProperty('--color', config.color);
    }

    canvasEl.style.height = height + 'px';
    destroyEl.onConnect = () => resizeObserver.observe(canvasEl);
    destroyEl.onDestroy = () => resizeObserver.disconnect();
    el.append(canvasEl, destroyEl);
});

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
