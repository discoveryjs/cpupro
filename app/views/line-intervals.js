import { utils } from '@discoveryjs/discovery';
import { resolveScopeProfileLine, resolveScopeViewport } from '../jora/profile.js';
import { lineViewport } from '../jora/viewport.js';

// Bands of intervals over a range; with zoom the line viewport is displayed within the range
discovery.view.define('line-intervals', function(el, config, data, context) {
    const intervals = Array.isArray(data) ? data : [];
    const range = resolveScopeViewport(config.viewport, context);
    const length = range.end - range.start;

    for (const { start, end, color } of intervals) {
        if (start < range.end && end > range.start) {
            const intervalEl = utils.createElement('div', 'interval');

            intervalEl.style.setProperty('--start', (start - range.start) / length);
            intervalEl.style.setProperty('--end', (end - range.start) / length);
            intervalEl.style.setProperty('--color', color);
            el.append(intervalEl);
        }
    }

    if (config.zoom) {
        const line = resolveScopeProfileLine(config.line, context);
        const profiles = context.data?.profiles;
        const destroyEl = utils.createElement('destroy-line-intervals');
        const followViewport = () => {
            const display = lineViewport(line, profiles);

            el.style.setProperty('--display-start', (display.start - range.start) / length);
            el.style.setProperty('--display-scale', length / (display.end - display.start));
        };
        let unsubscribe = null;

        destroyEl.onConnect = () => {
            unsubscribe = line.viewport.subscribe(followViewport);
            followViewport();
        };
        destroyEl.onDestroy = () => unsubscribe();
        el.append(destroyEl);
    }
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
