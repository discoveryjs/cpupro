const { resolveScopeProfileLine } = require('../jora/profile.js');
const { lineViewportBounds, lineZoom, setLineZoom, subscribeLineZoom } = require('../jora/viewport.js');
const { createState, rangeToSegments } = require('./ruler-range.js');
const { binsPerColumn } = require('./bins-histogram/index.js');

// Columns of histograms with bins over the grid showing a range: segments at boundaries of the columns
// within the range, the edge ones may be clipped
function gridColumns(grid, range, width) {
    const step = (grid.range.end - grid.range.start) / grid.count;
    const columnStep = step * binsPerColumn(
        (range.end - range.start) / step,
        grid.count,
        width,
        window.devicePixelRatio || 1
    );
    const boundaries = [range.start];

    for (
        let column = Math.floor((range.start - grid.range.start) / columnStep) + 1;
        grid.range.start + column * columnStep < range.end;
        column++
    ) {
        boundaries.push(grid.range.start + column * columnStep);
    }

    boundaries.push(range.end);

    return boundaries;
}

function getSelectionReader(rangeManager, multiple) {
    return multiple
        ? () => rangeManager.ranges ?? null
        : () => rangeManager.ranges?.[0] ?? null;
}

discovery.view.define('line-ruler', function(el, props, data, context) {
    const {
        line,
        range,
        segments,
        multiple = true,
        rangeManager,
        zoom = false,
        window,
        selection,
        details,
        onInit,
        onChange,
        formatLabel,
        ...rest
    } = props;
    const scopeLine = resolveScopeProfileLine(line, context);
    const readSelection = getSelectionReader(rangeManager, multiple);
    // Zoom moves the line zoom within the line viewport and the ruler follows the zoom; markers and labels keep
    // the steps and the origin of the viewport bounds, the whole recordings
    const bounds = zoom ? lineViewportBounds(scopeLine) : null;
    // With zoom the range and segments describe a grid of bins and the ruler segments are their columns.
    // A window value gives the grid of the current line window instead, its range and number of bins
    let grid = zoom && segments ? createState(range, segments) : null;
    let gridWindow = null;
    const readGrid = () => {
        if (window && window.value !== gridWindow) {
            gridWindow = window.value;
            grid = createState(gridWindow.scopeViewport, gridWindow.binCount);
        }

        return grid?.segments ? grid : null;
    };
    // Labels count from the start of the ruler, which is the viewport bounds for a zoomed one,
    // as line coordinates may be absolute timestamps. Their unit follows the whole scale, so zooming in
    // adds fraction digits for the steps of markers instead of switching to a smaller unit
    const scale = zoom ? bounds : createState(range).range;
    const origin = scale.start;
    const scaleLength = scale.end - scale.start;
    const formatScaleLabel = (value, range, step) => scopeLine.formatScaleValue(value - origin, scaleLength, step);
    let updatingRangeManager = false;

    return this.render(el, {
        ...rest,
        view: 'ruler',
        range: zoom ? lineZoom(scopeLine) : range,
        bounds,
        segments: readGrid() !== null
            ? (range, width) => {
                const { range: gridRange, segments: gridSegments } = readGrid();

                return gridColumns({ range: gridRange, count: gridSegments.length - 1 }, range, width);
            }
            : segments,
        multiple,
        selection: rangeManager ? readSelection() : selection,
        formatLabel: formatLabel || formatScaleLabel,
        details: details && {
            view: 'context',
            context(data, context) {
                const { ruler, detail } = context;
                const grid = readGrid();
                const { range, segments } = grid ?? ruler;
                const indices = rangeToSegments(detail, segments);

                return {
                    ...context,
                    // Details of a grid query its bins and range
                    ...grid && { scopeViewport: grid.range, binCount: segments.length - 1 },
                    duration: ruler.length,
                    timeStart: detail.start - range.start,
                    timeEnd: detail.end - range.start,
                    labelStart: detail.start - origin,
                    labelEnd: detail.end - origin,
                    // Values of the range tell apart a tenth of its length
                    resolution: (detail.end - detail.start) / 10,
                    segmentStart: indices?.start ?? 0,
                    segmentEnd: indices ? indices.end - 1 : -1
                };
            },
            content: details
        },
        onInit(api, data, context) {
            const cleanup = onInit?.(api, data, context);
            const unsubscribe = rangeManager?.subscribe(() => {
                if (!updatingRangeManager) {
                    api.setSelection(readSelection());
                }
            });
            const unsubscribeZoom = zoom
                ? subscribeLineZoom(scopeLine, () => api.setRange(lineZoom(scopeLine)))
                : null;

            return () => {
                unsubscribe?.();
                unsubscribeZoom?.();
                cleanup?.();
            };
        },
        onRangeChange: zoom && (api => {
            // The zoom is kept within the viewport, the ruler shows what is requested
            setLineZoom(scopeLine, api.state.range);
            api.setRange(lineZoom(scopeLine));
        }),
        onChange(api, data, context) {
            if (rangeManager) {
                const { selection } = api.state;

                try {
                    updatingRangeManager = true;
                    rangeManager.setRanges(selection === null || multiple
                        ? selection
                        : [selection]
                    );
                } finally {
                    updatingRangeManager = false;
                }
            }

            onChange?.(api, data, context);
        }
    }, data, context);
}, { tag: false });
