import { resolveScopeProfileLine, resolveScopeViewport } from '../jora/profile.js';
import { lineExtent, lineZoom, subscribeLineZoom } from '../jora/viewport.js';
import { validateRange } from '../prepare/computations/coordinates.js';
import usage from './line-histogram.usage.js';
import { setRangeCoverage } from './misc/range-coverage.js';

discovery.view.define('line-histogram', function(el, props, data, context) {
    const line = resolveScopeProfileLine(props.line, context);
    const extent = props.extent || lineExtent(line);

    // Bins already span the viewport; extent describes coverage, not a second bin grid.
    const viewport = resolveScopeViewport(props.viewport, context) || extent;

    // With zoom the bins span a window of the line zoom and the display follows the line zoom within it
    const profiles = context.data?.profiles;
    const display = props.zoom ? lineZoom(line, profiles) : viewport;

    validateRange(extent);
    validateRange(viewport);

    setRangeCoverage(el, extent, display);

    return this.render(el, {
        view: 'bins-histogram',
        bins: props.bins || data,
        range: viewport,
        viewport: display,
        presence: props.presence,
        peaks: props.peaks,
        color: props.color,
        height: props.height,
        max: props.max,
        scaleBins: props.scaleBins,
        scaleMax: props.scaleMax,
        binsMax: props.binsMax,
        scale: props.scale,
        onInit: props.zoom && (api => subscribeLineZoom(line, () => {
            const display = lineZoom(line, profiles);

            setRangeCoverage(el, extent, display);
            api.setViewport(display);
        }))
    }, data, context);
}, { usage });
