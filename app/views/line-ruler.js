const { resolveScopeProfileLine } = require('../jora/profile.js');
const { lineViewport, lineViewportBounds } = require('../jora/viewport.js');
const { formatMicrosecondsTime } = require('../prepare/misc/time-utils.js');
const { createState, rangeToSegments } = require('./ruler-range.js');
const { binsPerColumn } = require('./bins-histogram/index.js');

function formatMemory(size, total) {
    switch (true) {
        case total < 1_000_000:
            return `${(size / 1_000).toFixed(1).replace(/\.0$/, '')}Kb`;

        default:
            return `${(size / 1_000_000).toFixed(1).replace(/\.0$/, '')}Mb`;
    }
}

// Columns of histograms with bins over the grid showing a range: segments at boundaries of the columns
// within the range, the edge ones may be clipped
function gridColumns(grid, range, width) {
    const step = (grid.range.end - grid.range.start) / grid.count;
    const columnStep = step * binsPerColumn((range.end - range.start) / step, grid.count, width);
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
        selection,
        details,
        onInit,
        onChange,
        formatLabel,
        ...rest
    } = props;
    const scopeLine = resolveScopeProfileLine(line, context);
    const readSelection = getSelectionReader(rangeManager, multiple);
    // Zoom moves the line viewport within its bounds and the ruler follows the viewport
    const profiles = context.data?.profiles;
    const bounds = zoom ? lineViewportBounds(scopeLine, profiles) : null;
    // With zoom the range and segments describe a grid of bins and the ruler segments are their columns
    const grid = zoom && segments ? createState(range, segments) : null;
    const gridCount = grid?.segments ? grid.segments.length - 1 : 0;
    // Labels count from the start of the ruler, which is the viewport bounds for a zoomed one,
    // as line coordinates may be absolute timestamps
    const origin = zoom ? bounds.start : createState(range).range.start;
    let updatingRangeManager = false;

    return this.render(el, {
        ...rest,
        view: 'ruler',
        range: zoom ? lineViewport(scopeLine, profiles) : range,
        bounds,
        segments: gridCount > 0
            ? (range, width) => gridColumns({ range: grid.range, count: gridCount }, range, width)
            : segments,
        multiple,
        selection: rangeManager ? readSelection() : selection,
        formatLabel: formatLabel || ((value, range) =>
            scopeLine.type === 'memline'
                ? formatMemory(value - origin, range.end - range.start)
                : scopeLine.type === 'timeline'
                    ? formatMicrosecondsTime(value - origin, range.end - range.start)
                    : String(value - origin)
        ),
        details: details && {
            view: 'context',
            context(data, context) {
                const { ruler, detail } = context;
                const { range, segments } = gridCount > 0 ? grid : ruler;
                const indices = rangeToSegments(detail, segments);

                return {
                    ...context,
                    duration: ruler.length,
                    timeStart: detail.start - range.start,
                    timeEnd: detail.end - range.start,
                    labelStart: detail.start - origin,
                    labelEnd: detail.end - origin,
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
            const unsubscribeViewport = zoom
                ? scopeLine.viewport.subscribe(() => api.setRange(lineViewport(scopeLine, profiles)))
                : null;

            return () => {
                unsubscribe?.();
                unsubscribeViewport?.();
                cleanup?.();
            };
        },
        onRangeChange: zoom && (api => {
            const { start, end } = api.state.range;

            // The whole bounds is no request, so the viewport keeps following them
            if (start === bounds.start && end === bounds.end) {
                scopeLine.viewport.selection.resetRange();
            } else {
                scopeLine.viewport.selection.setRange(start, end);
            }
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
