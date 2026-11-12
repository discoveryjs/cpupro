import { utils } from '@discoveryjs/discovery';
import { resolveScopeProfileLine, resolveScopeViewport } from '../jora/profile.js';
import { lineZoom, subscribeLineZoom } from '../jora/viewport.js';

// Intervals over a range, bands or rendered items; with zoom the line zoom is displayed within the range
discovery.view.define('line-intervals', function(el, config, data, context) {
    const intervals = Array.isArray(data) ? data : [];
    const range = resolveScopeViewport(config.viewport, context);
    const length = range.end - range.start;
    const renders = [];

    for (const interval of intervals) {
        const { start, end, color } = interval;

        if (start < range.end && end > range.start) {
            const intervalEl = utils.createElement('div', 'interval');

            intervalEl.style.setProperty('--start', (start - range.start) / length);
            intervalEl.style.setProperty('--end', (end - range.start) / length);
            el.append(intervalEl);

            if (color) {
                intervalEl.style.setProperty('--color', color);
            }

            if (config.itemConfig) {
                renders.push(this.render(intervalEl, config.itemConfig, interval, context));
            }
        }
    }

    if (config.zoom) {
        const line = resolveScopeProfileLine(config.line, context);
        const destroyEl = utils.createElement('destroy-line-intervals');
        const followZoom = () => {
            const display = lineZoom(line);

            el.style.setProperty('--display-start', (display.start - range.start) / length);
            el.style.setProperty('--display-scale', length / (display.end - display.start));
        };
        let unsubscribe = null;

        destroyEl.onConnect = () => {
            unsubscribe = subscribeLineZoom(line, followZoom);
            followZoom();
        };
        destroyEl.onDestroy = () => unsubscribe();
        el.append(destroyEl);
    }

    return Promise.all(renders);
});

class LineIntervalsElement extends HTMLElement {
    connectedCallback() {
        this.onConnect();
        this.onConnect = null;
    }
    disconnectedCallback() {
        this.onDestroy();
        this.onDestroy = null;
    }
}

customElements.define('destroy-line-intervals', LineIntervalsElement);
