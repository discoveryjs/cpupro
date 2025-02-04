const delim = '<span class="num-delim"></span>';

function formatDuration(time) {
    time /= 1000;

    const number = time === 0
        ? 0
        : time >= 1000
            ? time.toFixed(1).replace(/\..+$|\B(?=(\d{3})+(\D|$))/g, m => m || delim)
            : time.toFixed(1);

    return `${number}${delim}`;
}

discovery.view.define('duration', function(el, config, data, context) {
    const { time, total } = typeof data === 'number' ? { time: data } : data;
    const timeEl = document.createElement('span');

    timeEl.className = context.data?.currentProfile?.type || 'time';
    timeEl.innerHTML = formatDuration(time);

    el.append(timeEl);

    if (total) {
        const fractionEl = document.createElement('span');
        const fraction = 100 * time / total;

        fractionEl.className = 'fraction';
        fractionEl.innerText = fraction === 0
            ? ''
            : fraction < 0.1
                ? '<0.1%'
                : fraction >= 99.9
                    ? Math.round(fraction) + '%'
                    : fraction.toFixed(1) + '%';

        el.append(fractionEl);
    }
});
