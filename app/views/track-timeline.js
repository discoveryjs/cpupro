import { resolveScopeProfileLine, resolveScopeViewport } from '../jora/profile.js';
import { lineViewport, lineViewportBounds } from '../jora/viewport.js';
import { TrackTimeline } from './track-timeline/index.js';
import Tooltip from './track-timeline/tooltip.js';
import { utils } from '@discoveryjs/discovery';

const defaultTooltipContent = [
    'text:text',
    'duration:end - start'
];

discovery.view.define('track-timeline', function(el, config, data, context) {
    const scopeLine = resolveScopeProfileLine(config.line, context);
    const viewport = resolveScopeViewport(config.viewport, context);
    const profiles = context.data?.profiles;
    // With zoom the view follows the line viewport within its bounds
    const bounds = config.zoom ? lineViewportBounds(scopeLine, profiles) : viewport;
    const { range } = scopeLine;
    const { selection } = range;
    const {
        tooltipContent = defaultTooltipContent,
        tooltipClassName,
        ruler = 'relative',
        spans = [],
        intervals = [],
        groups = false,
        unit = 'us',
        minX = bounds.start,
        maxX = bounds.end
    } = config;

    const tooltip = new Tooltip(discovery, (el, span) =>
        this.render(el, tooltipContent, span, {
            ...context,
            spanStart: span.start - minX,
            spanEnd: span.end - minX
        })
    );

    const destroyEl = utils.createElement('destroy-track-timeline');
    const canvasEl = utils.createElement('canvas', 'view-track-timeline__canvas');
    const overlayEl = utils.createElement('canvas', 'view-track-timeline__overlay');

    el.classList.add('no-view-ruler-tooltip');
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
                selection.setRange(span.start, span.end);
            } else {
                range.resetRange();
            }
        }
    });

    let rangeSubscription = null;
    let viewportSubscription = null;
    destroyEl.onConnect = () => {
        rangeSubscription = selection.subscribe(syncSelection);
        syncSelection();

        if (config.zoom) {
            viewportSubscription = scopeLine.viewport.subscribe(syncViewport);
            syncViewport();
        }
    };
    destroyEl.onDestroy = () => {
        rangeSubscription?.();
        viewportSubscription?.();
        trackTimeline.destroy();
        tooltip.destroy();
    };

    function syncSelection() {
        trackTimeline.setSelection(selection.ranges);
    }

    function syncViewport() {
        const { start, end } = lineViewport(scopeLine, profiles);

        trackTimeline.setView(start, end);
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
