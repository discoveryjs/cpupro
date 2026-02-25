const profileTooltip = [
    'text:name',
    { view: 'block', content: 'text:"Runtime: " + runtime.name' },
    'html:"<hr>"',
    { view: 'block', content: 'text-numeric:"Profile time: " + totalTime.ms()' },
    { view: 'block', content: 'text-numeric:"Samples: " + sourceInfo.samples' },
    { view: 'block', content: 'text-numeric:"Sampling interval: " + sourceInfo.samplesInterval' },
    'html:"<hr>"',
    { view: 'block', content: 'text-numeric:"Call tree nodes: " + sourceInfo.nodes' },
    { view: 'block', content: 'text-numeric:"Call frames: " + callFrames.size()' }
];

discovery.view.define('timeline-profiles', function(el, props, data, context) {
    const bucketProfiles = props.profiles || (Array.isArray(data) ? data : []);
    const min = props.startTime || props.startTime === 0
        ? props.startTime
        : discovery.query('profile.timeline.axisStart.min() or 0', bucketProfiles);
    const max = props.endTime || discovery.query('profile.timeline.axisEnd.max() or 0', bucketProfiles);
    const range = max - min;
    const activeProfiles = bucketProfiles.filter(profile => !profile.disabled);

    el.style.setProperty('--range', range);

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

        if (profile.timeDeltasByProfile) {
            const total = profile.timeline?.axisTotal;

            for (let i = activeProfiles.length - 1, start = 0; i >= 0; i--) {
                const duration = profile.timeDeltasByProfile[i];
                const presenceEl = document.createElement('div');

                presenceEl.className = 'profiles-presence';
                presenceEl.style.setProperty('--x1', start / total);
                presenceEl.style.setProperty('--x2', (start + duration) / total);
                presenceEl.style.setProperty('--presence', i / (activeProfiles.length - 1));

                viewportEl.append(presenceEl);

                start += duration;
            }
        }

        if (context.primaryProfile === profile) {
            barEl.classList.add('selected');
        } else {
            barEl.addEventListener('click', () => {
                discovery.action.call('selectProfile', profile);
            });
        }

        el.append(buttonEl, barEl);
        barEl.append(captionEl, viewportEl);
        this.tooltip(barEl, profileTooltip, profile, context);

        this.render(barEl, {
            view: 'sample-histogram',
            data: `
                $tree: profile.timeline.tree.categories.all.tree;
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
                    bins: $tree.binSignals({
                        test: => name not in ['root', 'idle'],
                        line: profile.timeline,
                        $skip,
                        total: $max - $min,
                        $binCount
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
});
