const delim = '<span class="num-delim"></span>';

function formatDuration(time) {
    time /= 1000;

    const number = time === 0
        ? 0
        : time >= 1000
            ? time.toFixed(1).replace(/\..+$|\B(?=(\d{3})+(\D|$))/g, m => m || delim)
            : time.toFixed(1);

    return `${number}${delim}ms`;
}

function createRender(getter) {
    return function render(el, config, data) {
        const time = typeof data === 'number' ? data : getter(data);
        const valueEl = document.createElement('span');
        const value = time !== 0 ? formatDuration(time) : '—';
        const unit = value.match(/[a-z]*$/i)[0];

        el.classList.add('view-time');

        valueEl.className = 'value';
        valueEl.dataset.unit = unit;
        valueEl.innerHTML = unit ? value.slice(0, -unit.length) : value;
        el.append(valueEl);

        if (time) {
            const fractionEl = document.createElement('span');
            fractionEl.className = 'fraction';
            fractionEl.append(discovery.query('totalPercent()', time));
            el.append(fractionEl);
        }
    };
}

discovery.view.define('self-time', createRender(data => data?.selfTime), { tag: 'span' });
discovery.view.define('nested-time', createRender(data => data?.totalTime - data?.selfTime), { tag: 'span' });
discovery.view.define('total-time', createRender(data => data?.totalTime), { tag: 'span' });
