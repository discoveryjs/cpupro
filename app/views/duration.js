import { renderMetricView } from './metric-render.js';

discovery.view.define('duration', function(el, config, data, context) {
    const { time, value = time, total } = typeof data === 'number' ? { time: data } : data || {};
    el.classList.add('view-metric');
    return renderMetricView(el, config, { value, total }, context);
});
