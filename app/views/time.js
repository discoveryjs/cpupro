const delim = '<span class="num-delim"></span>';
const definitions = {
    selfTime: '#### Self time\n\nThe time spent executing a function\'s own code, excluding any time used by other functions it calls.',
    nestedTime: '#### Nested time\n\nThe time accounted for the execution of functions that are called by a given function, excluding the time taken to execute the original function\'s own code itself.',
    totalTime: '#### Total time\n\nThe complete time taken to execute a function. It includes both \'self time\', which is the time the function spends executing its own code, and \'nested time\', which is the time spent executing all other functions that are called from within this function.'
};

function formatDuration(time, type = 'time') {
    time /= 1000;

    const number = time === 0
        ? 0
        : time >= 1000
            ? time.toFixed(1).replace(/\..+$|\B(?=(\d{3})+(\D|$))/g, m => m || delim)
            : time.toFixed(1);

    return `${number}${delim}${type === 'time' ? 'ms' : 'Kb'}`;
}

function createRender(slug, getter) {
    return function render(el, config, data, context) {
        const time = typeof data === 'number' ? data : getter(data);
        const valueEl = document.createElement('span');
        const value = time !== 0 ? formatDuration(time, context.currentProfile.type || 'time') : '—';
        const unit = value.match(/[a-z]*$/i)[0];

        el.classList.add('view-time');

        valueEl.className = 'value';
        valueEl.dataset.unit = unit;
        valueEl.innerHTML = unit ? value.slice(0, -unit.length) : value;
        el.append(valueEl);

        this.tooltip(el, {
            showDelay: true,
            className: 'cpupro-hint-tooltip',
            content: {
                view: 'md',
                source: definitions[slug]
            }
        });

        if (time) {
            const fractionEl = document.createElement('span');
            fractionEl.className = 'fraction';
            fractionEl.append(discovery.query('totalPercent()', time, context));
            el.append(fractionEl);
        }
    };
}

discovery.view.define('self-time', createRender('selfTime', data => data?.selfTime), { tag: 'span' });
discovery.view.define('nested-time', createRender('nestedTime', data => data?.totalTime - data?.selfTime), { tag: 'span' });
discovery.view.define('total-time', createRender('totalTime', data => data?.totalTime), { tag: 'span' });
