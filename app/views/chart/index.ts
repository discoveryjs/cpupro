import type { Range } from '../../prepare/computations/coordinates.js';
import { lowerBound } from '../../prepare/computations/misc.js';

// Points of a curve ordered by x
export type ChartSeries = {
    x: ArrayLike<number>;
    y: ArrayLike<number>;
};
export type ChartScaleY = ReturnType<typeof chartScaleY>;
export type ChartOptions = {
    // A filled area under a curve and a dashed line of a total over it
    series: ChartSeries;
    total: ChartSeries;
    // The recording coverage, curves extend by their edge values up to its bounds
    extent: Range;
    // The range of x across the canvas
    viewport: Range;
    scaleY: ChartScaleY;
};

// Vertical padding of a value range as its fraction
const PAD = 0.03;
const TICK_COLOR = '#555';
const TOTAL_DASH = [4, 1];

// Maps values to y in CSS pixels and places ticks over their range; the axis base is never below zero
export function chartScaleY(minY: number, maxY: number, height: number, tickCount = 4) {
    const span = maxY - minY || 1;
    const chartMinY = Math.max(0, minY - span * PAD);
    const chartMaxY = maxY + span * PAD;
    const padBottom = Math.ceil(height * (minY - chartMinY) / (chartMaxY - chartMinY));
    const padTop = Math.ceil(height * (chartMaxY - maxY) / (chartMaxY - chartMinY));
    const y = (value: number) => padTop + (height - padTop - padBottom) * (1 - (value - minY) / span);
    const ticks: { y: number; value: number }[] = [];

    for (let i = 0; i < tickCount; i++) {
        const value = minY + span * i / (tickCount - 1);

        ticks.push({ y: y(value), value });
    }

    return {
        y,
        base: y(chartMinY),
        ticks
    };
}

// Draws on the canvas grid in device pixels; the caller sizes the canvas to its CSS box and pixel ratio
export function drawChart(
    ctx: CanvasRenderingContext2D,
    options: ChartOptions,
    color: string,
    dpr: number
) {
    const { series, total, extent, viewport, scaleY } = options;
    const { width, height } = ctx.canvas;
    const scaleX = width / (viewport.end - viewport.start);
    const toX = (value: number) => (value - viewport.start) * scaleX;
    const toY = (value: number) => scaleY.y(value) * dpr;
    const base = scaleY.base * dpr;

    ctx.clearRect(0, 0, width, height);

    ctx.beginPath();
    for (let i = 0; i < scaleY.ticks.length; i++) {
        const tickY = scaleY.ticks[i].y * dpr;

        ctx.moveTo(0, tickY);
        ctx.lineTo(width, tickY);
    }
    ctx.lineWidth = dpr;
    ctx.strokeStyle = TICK_COLOR;
    ctx.stroke();

    if (series.x.length > 0) {
        ctx.beginPath();

        const [startX, endX] = traceCurve(ctx, series, extent, viewport, toX, toY);

        ctx.lineTo(endX, base);
        ctx.lineTo(startX, base);
        ctx.fillStyle = color;
        ctx.fill();
    }

    if (total.x.length > 0) {
        ctx.beginPath();
        traceCurve(ctx, total, extent, viewport, toX, toY);
        ctx.setLineDash(TOTAL_DASH.map(size => size * dpr));
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.setLineDash([]);
    }
}

// Traces a curve through the points within the viewport and a neighbour beyond each of its edges,
// returns the x of the curve ends
function traceCurve(
    ctx: CanvasRenderingContext2D,
    series: ChartSeries,
    extent: Range,
    viewport: Range,
    toX: (value: number) => number,
    toY: (value: number) => number
) {
    const { x, y } = series;
    const first = Math.max(lowerBound(x, viewport.start) - 1, 0);
    const last = Math.min(lowerBound(x, viewport.end), x.length - 1);
    // The curve extends by its edge values to the coverage edges
    const startX = toX(first === 0 ? Math.min(extent.start, x[0]) : x[first]);
    const endX = toX(last === x.length - 1 ? Math.max(extent.end, x[last]) : x[last]);
    // The points of a pixel column are drawn by the range of their values and the last one,
    // so a dense curve keeps its envelope with a few points per pixel
    let lastX = toX(x[first]);
    let lastY = toY(y[first]);
    let top = lastY;
    let bottom = lastY;
    const drawColumn = () => {
        ctx.lineTo(lastX, top);
        ctx.lineTo(lastX, bottom);
        ctx.lineTo(lastX, lastY);
    };

    ctx.moveTo(startX, lastY);
    ctx.lineTo(lastX, lastY);

    for (let i = first + 1; i <= last; i++) {
        const px = toX(x[i]);
        const py = toY(y[i]);

        if (Math.floor(px) !== Math.floor(lastX)) {
            drawColumn();
            ctx.lineTo(px, py);
            top = py;
            bottom = py;
        }

        top = Math.min(top, py);
        bottom = Math.max(bottom, py);
        lastX = px;
        lastY = py;
    }

    drawColumn();
    ctx.lineTo(endX, lastY);

    return [startX, endX];
}
