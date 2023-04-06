function generateSmoothPath(points, height) {
    const chartWidth = points.length;
    const maxValue = Math.max(...points);
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

discovery.view.define('timeline-segments', function(el, config, data, context) {
    if (!Array.isArray(data)) {
        data = [];
    }

    const count = 500;
    const totalTime = context.data.totalTime;
    const step = totalTime / count;
    const stat = new Uint32Array(count);
    for (const [segStart, segEnd] of data) {
        let start = Math.floor(segStart * count / totalTime);
        let end = Math.floor(segEnd * count / totalTime);

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

    pathEl.setAttribute('d', 'M 0 20 ' + generateSmoothPath(Array.from(stat), 20) + ' L ' + stat.length + ' 20 Z');
    svgEl.setAttribute('viewBox', `0 0 ${stat.length} 20`);
    svgEl.setAttribute('preserveAspectRatio', 'none');
    svgEl.setAttribute('width', '100%');
    svgEl.setAttribute('height', 20);
    svgEl.append(pathEl);
    el.append(svgEl);
});
