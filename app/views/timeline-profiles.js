import { utils } from '@discoveryjs/discovery';
import { lineViewport, lineViewportBounds, lineZoom, subscribeLineZoom } from '../jora/viewport.js';

const profileTooltip = [
    'text:name',
    { view: 'block', content: [
        'badge{ prefix: "pid", text: thread.pid }',
        'text:" "',
        'badge{ prefix: "tid", text: thread.tid }'
    ] },
    // { view: 'block', content: 'text:"Runtime: " + runtime.name' },
    { view: 'context', when: 'timeline', content: [
        'html:"<hr>"',
        { view: 'block', content: 'text-numeric:"Profile time: " + timeline.axisTotal.ms()' },
        { view: 'block', content: 'text-numeric:"CPU Samples: " + timeline.sourceInfo.samples' },
        { view: 'block', content: 'text-numeric:"Sampling interval: " + timeline.sourceInfo.samplesInterval' }
    ] },
    { view: 'context', when: 'memline', content: [
        'html:"<hr>"',
        { view: 'block', content: 'text-numeric:"Allocated memory: " + memline.axisTotal.bytes()' },
        { view: 'block', content: 'text-numeric:"Allocations: " + memline.sourceInfo.samples' }
    ] },
    'html:"<hr>"',
    { view: 'block', content: 'text-numeric:"Call tree nodes: " + timeline.sourceInfo.nodes.size()' },
    { view: 'block', content: 'text-numeric:"Call frames: " + callFrames.size()' }
];

discovery.view.define('timeline-profiles', function(el, props, data, context) {
    // Processes with more events of their threads go first
    const bucketProfiles = discovery.query(
        '.group(=>profile.thread.process)' +
        '.sort(key.threads.sum(=>events.size()) desc)' +
        '.value',
        props.profiles || (Array.isArray(data) ? data : [])
    );
    const min = props.startTime || props.startTime === 0
        ? props.startTime
        : discovery.query('profile.timeline.axisStart.min() or 0', bucketProfiles);
    const max = props.endTime || discovery.query('profile.timeline.axisEnd.max() or 0', bucketProfiles);
    const range = max - min;
    // const activeProfiles = bucketProfiles.filter(profile => !profile.disabled);

    el.style.setProperty('--range', range);

    let primaryBarEl = null;

    for (const { disabled, profile } of bucketProfiles) {
        const barEl = document.createElement('div');
        const viewportEl = document.createElement('div');
        const buttonEl = document.createElement('button');
        const captionEl = document.createElement('span');

        buttonEl.className = 'view-button toggle-disabled-button';
        buttonEl.addEventListener('click', () => {
            discovery.action.call('toggleProfile', profile);
        });

        captionEl.className = 'caption';
        captionEl.textContent = profile.name || '(unnamed profile)';

        barEl.className = `profile${disabled ? ' disabled' : ''}`;
        barEl.style.setProperty('--x1', (profile.timeline?.axisStart - min) / range);
        barEl.style.setProperty('--x2', (profile.timeline?.axisEnd - min) / range);

        viewportEl.className = 'viewport';

        // if (profile.timeDeltasByProfile) {
        //     const total = profile.timeline?.axisTotal;

        //     for (let i = activeProfiles.length - 1, start = 0; i >= 0; i--) {
        //         const duration = profile.timeDeltasByProfile[i];
        //         const presenceEl = document.createElement('div');

        //         presenceEl.className = 'profiles-presence';
        //         presenceEl.style.setProperty('--x1', start / total);
        //         presenceEl.style.setProperty('--x2', (start + duration) / total);
        //         presenceEl.style.setProperty('--presence', i / (activeProfiles.length - 1));

        //         viewportEl.append(presenceEl);

        //         start += duration;
        //     }
        // }

        if (context.primaryProfile === profile) {
            barEl.classList.add('selected');
            primaryBarEl = barEl;
        } else {
            barEl.addEventListener('click', () => {
                discovery.action.call('selectProfile', profile);
            });
        }

        el.append(buttonEl, barEl);
        barEl.append(captionEl, viewportEl);
        this.tooltip(barEl, profileTooltip, profile, context);

        this.render(barEl, {
            view: 'bins-histogram',
            data: `
                $tree: profile.timeline.breakdowns[];
                $treeMetrics: $tree.categories.all.nodes;
                $binCount: 750;
                $min: profiles.profile.timeline.axisStart.min();
                $max: profiles.profile.timeline.axisEnd.max();
                $skip: profile.timeline | axisStart + axisStartNoSamples - $min;

                {
                    profiles,
                    $min,
                    $max,
                    $skip,
                    total: $max - $min,
                    bins: $treeMetrics.binSignals({
                        test: => name not in ['root', 'idle'],
                        line: profile.timeline,
                        $tree,
                        $skip,
                        total: $max - $min,
                        n: $binCount
                    })
                }
            `,
            bins: '=bins',
            binsMax: true,
            height: 15,
            scale: '=step ? "linear" : "sqrt"',
            color: '#eee8'
        }, { profiles: bucketProfiles, profile }, context);
    }

    // The viewport, the zoom within it and selected ranges of the primary profile timeline are shown over all
    // profiles, the viewport is changed by selecting, moving or resizing a range on the primary profile
    // (other profiles are selected by a click)
    const line = context.primaryProfile?.timeline;

    if (line && primaryBarEl !== null && range > 0) {
        const profiles = context.data?.profiles;
        const selectionsEl = utils.createElement('div', 'selections');
        const viewportEl = utils.createElement('div', 'viewport-window');
        const zoomEl = utils.createElement('div', 'zoom-window');
        const readViewport = () => line.viewport.selection.ranges ? lineViewport(line, profiles) : null;
        const renderWindow = (windowEl, window) => {
            windowEl.hidden = window === null;
            windowEl.style.setProperty('--x1', window ? (window.start - min) / range : 0);
            windowEl.style.setProperty('--x2', window ? (window.end - min) / range : 1);
        };
        const renderViewport = () => {
            renderWindow(viewportEl, readViewport());
            renderWindow(zoomEl, line.zoom.selection.ranges ? lineZoom(line, profiles) : null);
        };
        const renderSelections = () => {
            selectionsEl.replaceChildren(...(line.range.selection.ranges || []).map(({ start, end }) => {
                const selectionEl = utils.createElement('div', 'selection');

                selectionEl.style.setProperty('--x1', (start - min) / range);
                selectionEl.style.setProperty('--x2', (end - min) / range);

                return selectionEl;
            }));
        };
        let updatingViewport = false;

        renderSelections();
        renderViewport();
        el.append(selectionsEl, viewportEl, zoomEl);

        return this.render(primaryBarEl, {
            view: 'ruler',
            range: { start: min, end: max },
            labels: false,
            grid: false,
            selection: readViewport(),
            onInit(api) {
                const unsubscribeViewport = subscribeLineZoom(line, () => {
                    renderViewport();

                    if (!updatingViewport) {
                        api.setSelection(readViewport());
                    }
                });
                const unsubscribeSelection = line.range.selection.subscribe(renderSelections);

                return () => {
                    unsubscribeViewport();
                    unsubscribeSelection();
                };
            },
            onChange(api) {
                const viewport = api.state.selection;
                const bounds = lineViewportBounds(line, profiles);

                updatingViewport = true;

                try {
                    // The whole bounds are no request, the viewport keeps following them
                    if (viewport === null || (viewport.start <= bounds.start && viewport.end >= bounds.end)) {
                        line.viewport.selection.resetRange();
                    } else {
                        line.viewport.selection.setRange(viewport.start, viewport.end);
                    }
                } finally {
                    updatingViewport = false;
                }
            }
        }, data, context);
    }
});
