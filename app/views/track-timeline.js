import { resolveScopeProfileLine, resolveScopeProfileLineBreakdown } from '../jora/profile.js';
import { TrackTimeline } from './track-timeline/index.js';
import Tooltip from './track-timeline/tooltip.js';
import { utils } from '@discoveryjs/discovery';

const defaultTooltipContent = [
    'text:text',
    'duration:end - start'
];

discovery.view.define('track-timeline', function(el, config, data, context) {
    const scopeLine = resolveScopeProfileLine(config.line, context);
    const scopeBreakdown = resolveScopeProfileLineBreakdown(null, scopeLine, context);
    const scopeLineStart = scopeLine.axisStart + scopeLine.axisStartNoSamples;
    const samplesMetrics = scopeBreakdown.samplesMetricsFiltered;
    const {
        tooltipContent = defaultTooltipContent,
        tooltipClassName,
        ruler = 'relative',
        spans = [],
        intervals = [],
        groups = false,
        unit = 'us',
        minX = null,
        maxX = null
    } = config;

    const tooltip = new Tooltip(discovery, (el, span) =>
        this.render(el, tooltipContent, span, {
            ...context,
            spanStart: span.start - scopeLineStart,
            spanEnd: span.end - scopeLineStart
        })
    );

    const destroyEl = utils.createElement('destroy-track-timeline');
    const canvasEl = utils.createElement('canvas', 'view-track-timeline__canvas');
    const overlayEl = utils.createElement('canvas', 'view-track-timeline__overlay');

    el.classList.add('no-view-time-ruler-tooltip');
    el.append(canvasEl, overlayEl, destroyEl);

    if (typeof tooltipClassName === 'string') {
        tooltip.el.classList.add(tooltipClassName);
    }

    const trackTimeline = new TrackTimeline(el, {
        ruler,
        groups,
        spans,
        intervals,
        unit,
        minX,
        maxX,
        onHover(span) {
            // console.log('Hover:', span?.text);
            if (span) {
                tooltip.show(span);
            } else {
                tooltip.hide();
            }
        },
        onClick(span) {
            // console.log('Click:', span?.text, span);
            if (span !== null) {
                samplesMetrics.setRange(span.start - scopeLineStart, span.end - scopeLineStart);
            } else {
                samplesMetrics.resetRange();
            }
        }
    });

    let samplesMetricsSubscription = null;
    destroyEl.onConnect = () => {
        samplesMetricsSubscription = samplesMetrics.subscribe(syncSelection);
        syncSelection();
    };
    destroyEl.onDestroy = () => {
        samplesMetricsSubscription?.();
        trackTimeline.destroy();
        tooltip.destroy();
    };

    function syncSelection() {
        if (samplesMetrics.rangeStart) {
            trackTimeline.setIntervals([...intervals, {
                start: samplesMetrics.rangeStart + scopeLineStart,
                end: samplesMetrics.rangeEnd + scopeLineStart,
                color: 'rgba(0, 152, 251, .1)',
                border: '#268fea66',
                text: 'selection'
            }]);
        } else {
            trackTimeline.setIntervals(intervals);
        }
    }
});

class TrackTimelineElement extends HTMLElement {
    connectedCallback() {
        this.onConnect();
        this.onConnect = null;
    }
    disconnectedCallback() {
        this.onDestroy();
        this.onDestroy = null;
    }
}

customElements.define('destroy-track-timeline', TrackTimelineElement);
