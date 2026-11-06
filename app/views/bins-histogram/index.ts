export type BinsScale = keyof typeof scaleFunctions;
export type BinsHistogramOptions = {
    bins: ArrayLike<number>;
    presence?: ArrayLike<number> | null;
    max?: number;
    binsMax?: boolean;
    scale?: BinsScale;
};

type ScaleFn = (value: number, max: number) => number;

const scaleFunctions = {
    linear: (value: number, max: number) => value / max,
    log: (value: number, max: number) => value > 0 ? Math.log(1 + value) / Math.log(1 + max) : 0,
    sqrt: (value: number, max: number) => Math.sqrt(value) / Math.sqrt(max)
};

// Present bins stay visible however small their value is
const MIN_BAR_HEIGHT = 0.8;
// Bars are separated by a tenth of their width once a whole pixel gap leaves most of the bar
const MIN_GAPPED_BAR_WIDTH = 4;
const BAR_GAP = 0.1;
const REL_BARS_OPACITY = 0.4;

// Draws on the canvas grid in device pixels; the caller sizes the canvas to its CSS box and pixel ratio
export function drawBinsHistogram(
    ctx: CanvasRenderingContext2D,
    { bins, presence = null, max, binsMax, scale = 'linear' }: BinsHistogramOptions,
    color: string,
    dpr: number
) {
    const { width, height } = ctx.canvas;
    const scaleFn = scaleFunctions[scale];
    const minHeight = Math.max(1, Math.round(MIN_BAR_HEIGHT * dpr));
    let binsMaxValue = 0;

    for (let i = 0; i < bins.length; i++) {
        binsMaxValue = Math.max(binsMaxValue, bins[i]);
    }

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = color;

    // Bins scaled to their own maximum show the shape behind bins scaled to a shared maximum
    if (binsMax && max && binsMaxValue < max * 0.9) {
        ctx.globalAlpha = REL_BARS_OPACITY;
        drawBars(ctx, bins, null, binsMaxValue, scaleFn, minHeight);
        ctx.globalAlpha = 1;
    }

    drawBars(ctx, bins, presence, max || binsMaxValue, scaleFn, minHeight);
}

function drawBars(
    ctx: CanvasRenderingContext2D,
    bins: ArrayLike<number>,
    presence: ArrayLike<number> | null,
    max: number,
    scaleFn: ScaleFn,
    minHeight: number
) {
    const { width, height } = ctx.canvas;
    let start = 0;
    let value = 0;
    let present = false;

    ctx.beginPath();

    for (let i = 0; i < bins.length; i++) {
        const end = Math.floor((i + 1) * width / bins.length);

        // Bins narrower than a pixel share it, the pixel shows the maximum of the bins ending in it
        value = Math.max(value, scaleFn(bins[i], max) || 0);

        if (presence && presence[i] > 0) {
            present = true;
        }

        if (end > start) {
            if (value > 0 || present) {
                const barWidth = end - start;
                const barHeight = Math.max(Math.round(value * height), minHeight);
                const gap = barWidth >= MIN_GAPPED_BAR_WIDTH ? Math.ceil(barWidth * BAR_GAP) : 0;

                ctx.rect(start, height - barHeight, barWidth - gap, barHeight);
            }

            start = end;
            value = 0;
            present = false;
        }
    }

    ctx.fill();
}
