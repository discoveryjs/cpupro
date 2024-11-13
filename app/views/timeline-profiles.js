discovery.view.define('timeline-profiles', function(el, props, data, context) {
    const profiles = props.profiles || (Array.isArray(data) ? data : []);
    const min = props.startTime || props.startTime === 0
        ? props.startTime
        : discovery.query('startTime.min() or 0', profiles);
    const max = props.endTime || discovery.query('endTime.max() or 0', profiles);
    const range = max - min;
    const activeProfiles = profiles.filter(profile => !profile.disabled);

    el.style.setProperty('--range', range);

    for (const profile of profiles) {
        const barEl = document.createElement('div');
        const buttonEl = document.createElement('button');

        buttonEl.className = 'view-button toggle-disabled-button';
        buttonEl.addEventListener('click', () => {
            discovery.action.call('toggleProfile', profile);
        });

        barEl.className = `profile${profile.disabled ? ' disabled' : ''}`;
        barEl.style.setProperty('--x1', (profile.startTime - min) / range);
        barEl.style.setProperty('--x2', (profile.endTime - min) / range);

        if (profile.timeDeltasByProfile) {
            const total = profile.timeDeltasByProfile.reduce((s, n) => s + n, 0);

            for (let i = activeProfiles.length - 1, start = 0; i >= 0; i--) {
                const duration = profile.timeDeltasByProfile[i];
                const presenceEl = document.createElement('div');

                presenceEl.style.setProperty('--x1', start / total);
                presenceEl.style.setProperty('--x2', (start + duration) / total);

                barEl.append(presenceEl);

                start += duration;
            }
        }

        if (context.data.currentProfile?.samples === profile.samples) {
            barEl.classList.add('selected');
        } else {
            barEl.addEventListener('click', () => {
                discovery.action.call('selectProfile', profile);
            });
        }

        el.append(buttonEl, barEl);
        this.tooltip(barEl, [
            'text:name',
            { view: 'block', content: 'text:"Runtime: " + runtime.name' },
            'html:"<hr>"',
            { view: 'block', content: 'text-numeric:"Profile time: " + totalTime.ms()' },
            { view: 'block', content: 'text-numeric:"Samples: " + sourceInfo.samples' },
            { view: 'block', content: 'text-numeric:"Sampling interval: " + sourceInfo.samplesInterval' },
            'html:"<hr>"',
            { view: 'block', content: 'text-numeric:"Call tree nodes: " + sourceInfo.nodes' },
            { view: 'block', content: 'text-numeric:"Call frames: " + callFrames.size()' }
        ], profile, context);
    }
});
