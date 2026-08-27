const pad = 0.03;

discovery.view.define('cpupro-chart', function(el, config, data) {
    const points = ensureArray(config.points || data);
    const x = points.map(p => p.x ?? p[0]);
    const y = points.map(p => p.y ?? p[1]);
    const totalPoints = ensureArray(config.pointsTotal);
    const totalX = totalPoints.map(p => p.x ?? p[0]);
    const totalY = totalPoints.map(p => p.y ?? p[1]);
    const minY = config.minY ?? Math.min(...y);
    const maxY = config.maxY ?? Math.max(...y, ...totalY);
    const minX = config.minX ?? Math.min(...x);
    const maxX = config.maxX ?? Math.max(...x);
    const height = config.height || 150;

    if (config.color) {
        el.style.setProperty('--color', config.color);
    }

    // svg
    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const { ticks } = generateYTicks(minY, maxY, height);

    pathEl.setAttribute('d', generateCurve(x, y, height, minX, maxX, minY, maxY));
    svgEl.setAttribute('viewBox', `0 0 1000 ${height}`);
    svgEl.setAttribute('preserveAspectRatio', 'none');
    svgEl.setAttribute('width', '100%');
    svgEl.setAttribute('height', height);
    svgEl.append(...generateYLines(ticks));
    svgEl.append(pathEl);

    if (totalPoints.length > 0) {
        const pathTotalEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');

        pathTotalEl.setAttribute('d', generateCurve(totalX, totalY, height, minX, maxX, minY, maxY, true));
        pathTotalEl.setAttribute('stroke-dasharray', '4 1');
        pathTotalEl.classList.add('line');
        svgEl.append(pathTotalEl);
    }

    el.append(...generateYLabels(ticks, config.labelFormat));
    el.append(svgEl);
});

function ensureArray(value) {
    return Array.isArray(value) ? value : [];
}

function generateYTicks(minY, maxY, height, count = 4) {
    const scaleY = (val) => padTop + (height - padTop - padBottom) * (1 - (val - minY) / (maxY - minY));
    const chartMinY = Math.max(0, minY - (maxY - minY) * pad);
    const chartMaxY = maxY + (maxY - minY) * pad;
    const padBottom = Math.ceil(height * (minY - chartMinY) / (chartMaxY - chartMinY));
    const padTop = Math.ceil(height * (chartMaxY - maxY) / (chartMaxY - chartMinY));
    const step = (maxY - minY) / (count - 1);
    const ticks = [];

    for (let i = 0; i < count; i++) {
        const value = minY + step * i;
        const y = scaleY(value);

        ticks.push({ y, value });
    }

    return {
        ticks,
        padTop,
        padBottom,
        stepY: step,
        step: (height - padTop - padBottom) / (count - 1)
    };
}

function generateYLabels(ticks, formatFn = (v) => v.toFixed(2)) {
    const labels = [];

    for (const { y, value } of ticks) {
        const labelEl = document.createElement('span');

        labelEl.classList.add('y-tick-label');
        labelEl.style.setProperty('--top', `${y}px`);
        labelEl.textContent = formatFn(value);

        labels.push(labelEl);
    }

    return labels;
}

function generateYLines(ticks) {
    const lines = [];

    for (const { y } of ticks) {
        const lineEl = document.createElementNS('http://www.w3.org/2000/svg', 'line');

        lineEl.classList.add('y-tick');
        lineEl.setAttribute('x1', 0);
        lineEl.setAttribute('y1', y);
        lineEl.setAttribute('x2', 1000);
        lineEl.setAttribute('y2', y);

        lines.push(lineEl);
    }

    return lines;
}

function generateCurve(x, y, height, minX, maxX, minY, maxY, line = false) {
    const scaleX = (val) => 1000 * (val - minX) / (maxX - minX);
    const scaleY = (val) => padTop + (height - padTop - padBottom) * (1 - (val - minY) / (maxY - minY));
    const chartMinY = Math.max(0, minY - (maxY - minY) * pad);
    const chartMaxY = maxY + (maxY - minY) * pad;
    const padBottom = Math.ceil(height * (minY - chartMinY) / (chartMaxY - chartMinY));
    const padTop = Math.ceil(height * (chartMaxY - maxY) / (chartMaxY - chartMinY));

    let prevScaledY = scaleY(y[0]);
    let yspan = 0;
    let d = '';

    if (line) {
        d += `M ${scaleX(minX)} ${prevScaledY} `;
    } else {
        d += `M ${scaleX(minX)} ${scaleY(chartMinY)} `;
        d += `V ${prevScaledY} `;
    }

    d += `H ${scaleX(x[0])} `;

    for (let i = 1; i < x.length; i++) {
        const scaledX = scaleX(x[i]);
        const scaledY = scaleY(y[i]);

        if (Math.abs((scaledY - prevScaledY)) > .3) {
            if (yspan > 0) {
                d += `H ${scaleX(x[i - 1])} `;
                yspan = 0;
            }

            d += `L ${scaledX} ${scaledY} `;
            prevScaledY = scaledY;
        } else {
            yspan++;
        }
    }

    if (line) {
        d += `H ${scaleX(maxX)}`;
    } else {
        d += `L ${scaleX(maxX)} ${scaleY(y[y.length - 1])} V ${scaleY(chartMinY)} Z`;
    }

    return d;
}
