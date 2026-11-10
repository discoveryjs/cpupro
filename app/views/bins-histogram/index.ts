import type { Range } from '../../prepare/computations/coordinates.js';

export type BinsScale = keyof typeof scaleFunctions;
export type BinsHistogramOptions = {
    bins: ArrayLike<number>;
    // Bins split the range evenly; the canvas shows the viewport within it when both are given
    range?: Range | null;
    viewport?: Range | null;
    presence?: ArrayLike<number> | null;
    // Bins hold peaks of a level (e.g. a heap size) rather than amounts, a column shows the highest one
    peaks?: boolean;
    // A maximum of a single bin, a column of merged amounts compares with the sum of their maximums
    max?: number;
    // Series sharing the scale (e.g. the total of tracks), the highest of their visible columns is the full height
    scaleBins?: ArrayLike<number>[] | null;
    // The highest column of a duration over all the data the bins are a window of (e.g. the line viewport) is the full
    // height: panning never changes the scale, columns of another merge level get a maximum of their own
    scaleMax?: ColumnMaxFn | null;
    // A shadow of the bins scaled to their own maximum as if they were alone, it shows the unevenness of bins low on
    // a shared scale. A function gives the highest column of a duration over all the data, as scaleMax does
    binsMax?: boolean | ColumnMaxFn;
    scale?: BinsScale;
};

type ScaleFn = (value: number, max: number) => number;
// Columns of a duration start at multiples of it from a column start
type ColumnMaxFn = (columnDuration: number, columnStart: number) => number;
type ColumnValueFn = (bins: ArrayLike<number>, start: number, size: number) => number;
type Columns = {
    // Bins per column
    size: number;
    // Canvas placement in bins: the offset of the canvas start and the number of bins across the canvas
    offset: number;
    count: number;
};

const scaleFunctions = {
    linear: (value: number, max: number) => value / max,
    log: (value: number, max: number) => value > 0 ? Math.log(1 + value) / Math.log(1 + max) : 0,
    sqrt: (value: number, max: number) => Math.sqrt(value) / Math.sqrt(max)
};

// Many thin columns are hard to compare, so neighbouring bins merge into columns by powers of two.
// A column shows the sum of its bins: in tracks splitting a total, a share stays a share of the column.
// Only the peak of a level merges as the highest peak, a sum or a mean of peaks would be no peak at all.
// Columns keep a bar at least as wide as their gap in device pixels, so retina screens fit more of them.
const MAX_COLUMNS = 500;
// Present bins stay visible however small their value is
const MIN_BAR_HEIGHT = 0.8;
// Columns keep the same gap however wide they are, zooming changes only how much of a column a bar fills.
// Columns are placed at their exact positions, as snapping them to pixels makes their edges jump on zoom.
const BAR_GAP = 0.5;
const REL_BARS_OPACITY = 0.4;

// Draws on the canvas grid in device pixels; the caller sizes the canvas to its CSS box and pixel ratio
export function drawBinsHistogram(
    ctx: CanvasRenderingContext2D,
    {
        bins,
        range = null,
        viewport = null,
        presence = null,
        peaks = false,
        max,
        scaleBins = null,
        scaleMax = null,
        binsMax,
        scale = 'linear'
    }: BinsHistogramOptions,
    color: string,
    dpr: number
) {
    const { width, height } = ctx.canvas;
    const scaleFn = scaleFunctions[scale];
    const minHeight = Math.max(1, Math.round(MIN_BAR_HEIGHT * dpr));
    const gap = barGap(dpr);
    const columns = { size: 1, offset: 0, count: bins.length };
    const columnValue = peaks ? columnPeak : columnSum;

    if (range && viewport && range.end > range.start && viewport.end > viewport.start) {
        const binSize = (range.end - range.start) / bins.length;

        columns.offset = (viewport.start - range.start) / binSize;
        columns.count = (viewport.end - viewport.start) / binSize;
    }

    columns.size = binsPerColumn(columns.count, bins.length, width / dpr, dpr);

    // Bins split the range in durations, or are units of their own
    const columnDuration = range && range.end > range.start
        ? columns.size * (range.end - range.start) / bins.length
        : columns.size;
    const columnStart = range ? range.start : 0;
    // Without a maximum over all the data, the scale depends only on the visible columns rather than on the range
    // of bins, which follows the viewport in steps and may hold columns far higher than any visible one
    const columnsMax = typeof binsMax === 'function'
        ? binsMax(columnDuration, columnStart)
        : visibleColumnsMax(bins, columns, columnValue);

    if (max && !peaks) {
        max *= columns.size;
    }

    if (!max && scaleMax !== null) {
        max = scaleMax(columnDuration, columnStart);
    }

    if (!max && scaleBins !== null) {
        max = 0;

        for (const series of scaleBins) {
            max = Math.max(max, visibleColumnsMax(series, columns, columnValue));
        }
    }

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = color;

    // Columns scaled to their own maximum show the shape behind columns scaled to a shared maximum
    if (binsMax && max && columnsMax < max * 0.9) {
        ctx.globalAlpha = REL_BARS_OPACITY;
        drawColumns(ctx, bins, columns, columnValue, null, columnsMax, scaleFn, minHeight, gap);
        ctx.globalAlpha = 1;
    }

    drawColumns(ctx, bins, columns, columnValue, presence, max || columnsMax, scaleFn, minHeight, gap);
}

// Bins per column for a number of bins across a width in CSS pixels at a pixel ratio, e.g. to match columns with a ruler
export function binsPerColumn(binsAcross: number, binCount: number, width: number, dpr: number) {
    const maxColumns = Math.min(MAX_COLUMNS, width * dpr / (2 * barGap(dpr)));
    let size = 1;

    while (binsAcross / size > maxColumns && size < binCount) {
        size *= 2;
    }

    return size;
}

function visibleColumnsMax(bins: ArrayLike<number>, { size, offset, count }: Columns, columnValue: ColumnValueFn) {
    const start = Math.max(0, Math.floor(offset / size) * size);
    const end = Math.min(bins.length, offset + count);
    let max = 0;

    for (let i = start; i < end; i += size) {
        max = Math.max(max, columnValue(bins, i, size));
    }

    return max;
}

// The gap between columns in device pixels
function barGap(dpr: number) {
    return Math.max(1, Math.round(BAR_GAP * dpr));
}

function columnSum(bins: ArrayLike<number>, start: number, size: number) {
    const end = Math.min(bins.length, start + size);
    let sum = 0;

    for (let i = start; i < end; i++) {
        sum += bins[i];
    }

    return sum;
}

function columnPeak(bins: ArrayLike<number>, start: number, size: number) {
    const end = Math.min(bins.length, start + size);
    let peak = 0;

    for (let i = start; i < end; i++) {
        peak = Math.max(peak, bins[i]);
    }

    return peak;
}

function drawColumns(
    ctx: CanvasRenderingContext2D,
    bins: ArrayLike<number>,
    { size, offset, count }: Columns,
    columnValue: ColumnValueFn,
    presence: ArrayLike<number> | null,
    max: number,
    scaleFn: ScaleFn,
    minHeight: number,
    gap: number
) {
    const { width, height } = ctx.canvas;
    const first = Math.max(0, Math.floor(offset / size) * size);

    ctx.beginPath();

    for (let i = first; i < bins.length; i += size) {
        const start = Math.max(0, (i - offset) * width / count);
        const end = Math.min(width, (i + size - offset) * width / count - gap);
        const value = scaleFn(columnValue(bins, i, size), max) || 0;

        if (start >= width) {
            break;
        }

        if (end > start && (value > 0 || (presence !== null && columnSum(presence, i, size) > 0))) {
            const barHeight = Math.max(Math.round(value * height), minHeight);

            ctx.rect(start, height - barHeight, end - start, barHeight);
        }
    }

    ctx.fill();
}
