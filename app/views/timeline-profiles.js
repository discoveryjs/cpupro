discovery.view.define('timeline-profiles', function(el, config, data, context) {
    const profiles = Array.isArray(data) ? data : [];
    const min = discovery.query('startTime.min() or 0', profiles);
    const max = discovery.query('endTime.max() or 0', profiles);
    const range = max - min;

    el.style.setProperty('--range', range);

    for (const profile of profiles) {
        const barEl = document.createElement('div');

        barEl.className = 'profile';
        barEl.style.setProperty('--x1', (profile.startTime - min) / range);
        barEl.style.setProperty('--x2', (profile.endTime - min) / range);

        if (context.data.samples === profile.samples) {
            barEl.classList.add('selected');
        } else {
            barEl.addEventListener('click', () => {
                discovery.data = {
                    ...discovery.data,
                    ...profile
                };
                discovery.scheduleRender();
            });
        }

        el.append(barEl);
    }
});
