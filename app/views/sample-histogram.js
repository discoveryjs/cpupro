const { utils } = require('@discoveryjs/discovery');
const { resolveScopeProfileLine } = require('../jora/profile.ts');

function generateSmoothPath(points, height) {
    const chartWidth = points.length;
    const maxValue = Math.max(...points) || 1;
    const normalizedY = points.map((point) => height - (point / maxValue) * height);
    const stepX = chartWidth / (points.length - 1);

    const pathData = [];
    const n = points.length;
    const tangents = [0];

    for (let i = 1; i < n - 1; ++i) {
        const deltaY = normalizedY[i + 1] - normalizedY[i - 1];
        const deltaX = 2 * stepX;
        tangents.push(deltaY / deltaX);
    }

    tangents.push(0);

    pathData.push('M', 0, height);
    pathData.push('L', 0, normalizedY[0]);

    for (let i = 0; i < n - 1; ++i) {
        const x0 = i * stepX;
        const y0 = normalizedY[i];
        const x1 = (i + 1) * stepX;
        const y1 = normalizedY[i + 1];
        const dx = stepX / 3;
        const t0 = tangents[i];
        const t1 = tangents[i + 1];

        pathData.push(
            'C',
            x0 + dx,
            y0 + dx * t0,
            x1 - dx,
            y1 - dx * t1,
            x1,
            y1
        );
    }

    pathData.push('L', chartWidth, height);
    pathData.push('Z');

    return pathData.join(' ');
}

const scaleFunctions = {
    linear: (value, maxValue) => value / maxValue,
    log: (value, maxValue) => (value > 0 ? Math.log(1 + value) / Math.log(1 + maxValue) : 0),
    sqrt: (value, maxValue) => Math.sqrt(value) / Math.sqrt(maxValue)
};

function generateSquarePath(points, height, maxValue, presence, scaleFn = scaleFunctions.linear) {
    const chartWidth = points.length;
    const stepX = chartWidth / points.length;
    const pathData = [];
    const gap = 0.1;
    const minNonZeroHeight = .8;

    pathData.push('M', 0, height);

    for (let i = 0; i < points.length; ++i) {
        const rawValue = points[i];
        const y = scaleFn(rawValue, maxValue);

        if (y > 0 || presence?.[i] > 0) {
            pathData.push(
                'V', height - Math.max(y * height, minNonZeroHeight),
                'h', stepX - gap,
                'V', height,
                'h', gap
            );
        } else {
            pathData.push('h', stepX);
        }
    }

    pathData.push('L', chartWidth, height);
    pathData.push('Z');

    return pathData.join(' ');
}

discovery.view.define('timeline-segments', function(el, config, data, context) {
    data = ensureArray(data);

    el.classList.add('view-sample-histogram');

    const line = resolveScopeProfileLine(config.line, context);
    const totalValue = line.axisTotal || 1;
    const count = 500;
    const step = totalValue / count;
    const stat = new Uint32Array(count);
    for (const [segStart, segEnd] of data) {
        let start = Math.floor(segStart * count / totalValue);
        let end = Math.floor(segEnd * count / totalValue);

        // console.log('segment', [segStart, segEnd], [segStart, segEnd], [start, end]);

        if (start === end) {
            stat[start] += segEnd - segStart;
            // console.log('start === end', a[start]);
        } else {
            stat[start] += step * (start + 1) - segStart;
            stat[end] += segEnd - step * end;
            // console.log('start !== end', a[start], a[end], segEnd, step * end, step * (end - 1));
        }

        for (let i = start + 1; i < end; i++) {
            stat[i] += step;
            // console.log('i', i, a[i], step);
        }
    }

    // svg
    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');

    pathEl.setAttribute('d', generateSmoothPath(Array.from(stat), 20));
    svgEl.setAttribute('viewBox', `0 0 ${stat.length} 20`);
    svgEl.setAttribute('preserveAspectRatio', 'none');
    svgEl.setAttribute('width', '100%');
    svgEl.setAttribute('height', 20);
    svgEl.append(pathEl);
    el.append(svgEl);
});

function ensureArray(value) {
    return utils.isArray(value) ? value : [];
}

discovery.view.define('sample-histogram', function(el, config, data) {
    const presence = config.presence;
    const bins = ensureArray(config.bins || data);
    const height = config.height || 20;
    const scaleFn = scaleFunctions[config.scale || 'linear']; // 'linear', 'log', 'sqrt'
    let maxValue = Math.max(...bins);

    if (config.color) {
        el.style.setProperty('--color', config.color);
    }

    // svg
    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');

    pathEl.setAttribute('d', generateSquarePath(Array.from(bins), height, config.max || maxValue, presence, scaleFn));
    svgEl.setAttribute('viewBox', `0 0 ${bins.length} ${height}`);
    svgEl.setAttribute('preserveAspectRatio', 'none');
    svgEl.setAttribute('width', '100%');
    svgEl.setAttribute('height', height);
    svgEl.append(pathEl);
    el.append(svgEl);

    // maxValue is less than config max by 10%
    if (config.binsMax && config.max && maxValue < config.max * 0.9) {
        const relPathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        relPathEl.classList.add('rel-path');
        relPathEl.setAttribute('d', generateSquarePath(Array.from(bins), height, maxValue, undefined, scaleFn));
        svgEl.prepend(relPathEl);
    }
});
