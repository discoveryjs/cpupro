export const SPAN_LABEL_FONT = '10px system-ui';

type LabelMetrics = {
    width: number;
    firstWidth: number;
};

export class SpanLabels {
    private readonly metrics = new Map<string, LabelMetrics>();
    private readonly segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

    clear(): void {
        this.metrics.clear();
    }

    fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
        if (!text || maxWidth <= 0) {
            return '';
        }

        let metrics = this.metrics.get(text);

        if (!metrics) {
            const first = this.segmenter.segment(text)[Symbol.iterator]().next().value!.segment;

            metrics = {
                width: ctx.measureText(text).width,
                firstWidth: first.length === text.length ? Infinity : ctx.measureText(first + '\u2026').width
            };
            this.metrics.set(text, metrics);
        }

        if (metrics.width <= maxWidth) {
            return text;
        }

        if (metrics.firstWidth > maxWidth) {
            return '';
        }

        const boundaries = Array.from(this.segmenter.segment(text), part => part.index + part.segment.length);
        let lower = 1;
        let upper = boundaries.length - 1;

        while (lower < upper) {
            const middle = (lower + upper + 1) >>> 1;
            const candidate = text.slice(0, boundaries[middle - 1]) + '\u2026';

            if (ctx.measureText(candidate).width <= maxWidth) {
                lower = middle;
            } else {
                upper = middle - 1;
            }
        }

        return text.slice(0, boundaries[lower - 1]) + '\u2026';
    }
}
