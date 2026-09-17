const { resolveScopeProfileLine } = require('../jora/profile.js');
const { formatMicrosecondsTime } = require('../prepare/misc/time-utils.js');
const { rangeToSegments } = require('./ruler-range.js');

function formatMemory(size, total) {
    switch (true) {
        case total < 1_000_000:
            return `${(size / 1_000).toFixed(1).replace(/\.0$/, '')}Kb`;

        default:
            return `${(size / 1_000_000).toFixed(1).replace(/\.0$/, '')}Mb`;
    }
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
        selection,
        details,
        onInit,
        onChange,
        formatLabel,
        ...rest
    } = props;
    const scopeLine = resolveScopeProfileLine(line, context);
    const readSelection = getSelectionReader(rangeManager, multiple);
    let updatingRangeManager = false;

    return this.render(el, {
        ...rest,
        view: 'ruler',
        range,
        segments,
        multiple,
        selection: rangeManager ? readSelection() : selection,
        formatLabel: formatLabel || ((value, range) =>
            scopeLine.type === 'memline'
                ? formatMemory(value, range.end - range.start)
                : scopeLine.type === 'timeline'
                    ? formatMicrosecondsTime(value, range.end - range.start)
                    : String(value)
        ),
        details: details && {
            view: 'context',
            context(data, context) {
                const { ruler, detail } = context;
                const indices = rangeToSegments(detail, ruler.segments);

                return {
                    ...context,
                    duration: ruler.length,
                    timeStart: detail.start - ruler.range.start,
                    timeEnd: detail.end - ruler.range.start,
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

            return () => {
                unsubscribe?.();
                cleanup?.();
            };
        },
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
