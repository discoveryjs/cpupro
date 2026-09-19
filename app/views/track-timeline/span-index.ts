import type { Span } from './types.js';

export class SpanIndex {
    private readonly size: number;
    private readonly ends: Float64Array;

    constructor(private readonly spans: Span[]) {
        const size = this.size = 2 ** Math.ceil(Math.log2(Math.max(1, spans.length)));
        const ends = this.ends = new Float64Array(size * 2).fill(-Infinity);

        for (let index = 0; index < spans.length; index++) {
            ends[size + index] = Math.max(spans[index].start, spans[index].end);
        }

        for (let index = size - 1; index > 0; index--) {
            ends[index] = Math.max(ends[index * 2], ends[index * 2 + 1]);
        }
    }

    forEachVisible(
        viewStart: number,
        viewEnd: number,
        minDuration: number,
        visit: (span: Span, start: number, end: number) => void
    ): void {
        const { spans, ends, size } = this;

        function walk(node: number, first: number, last: number) {
            if (first >= spans.length) {
                return;
            }

            const span = spans[first];
            const start = span.start;
            const end = ends[node];

            if (end < viewStart || start >= viewEnd) {
                return;
            }

            if (last - first === 1 ||
                (start >= viewStart && end <= viewEnd && end - start < minDuration)) {
                visit(span, start, end);
                return;
            }

            const middle = (first + last) >>> 1;

            walk(node * 2, first, middle);
            walk(node * 2 + 1, middle, last);
        }

        if (viewEnd > viewStart) {
            walk(1, 0, size);
        }
    }
}
