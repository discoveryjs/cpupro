import { resolveScopeProfileLine, resolveScopeViewport } from '../jora/profile.js';
import { lineExtent } from '../jora/viewport.js';
import { validateRange } from '../prepare/computations/coordinates.js';
import usage from './line-histogram.usage.js';
import { setRangeCoverage } from './misc/range-coverage.js';

discovery.view.define('line-histogram', function(el, props, data, context) {
    const extent = props.extent || lineExtent(resolveScopeProfileLine(props.line, context));

    // Bins already span the viewport; extent describes coverage, not a second bin grid.
    const viewport = resolveScopeViewport(props.viewport, context) || extent;

    validateRange(extent);
    validateRange(viewport);

    setRangeCoverage(el, extent, viewport);

    return this.render(el, {
        view: 'bins-histogram',
        bins: props.bins || data,
        presence: props.presence,
        color: props.color,
        height: props.height,
        max: props.max,
        binsMax: props.binsMax,
        scale: props.scale
    }, data, context);
}, { usage });
