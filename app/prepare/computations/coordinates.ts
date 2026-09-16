import { Observer } from './misc.js';

export type CoordinateSpace = Readonly<{ name: string; unit: string }>;
export type Range = Readonly<{ start: number; end: number }>;
export type RangeSet = readonly Range[];

function areRangeBoundsValid(start: number | null, end: number | null): boolean {
    return (
        (start === null || Number.isFinite(start)) &&
        (end === null || Number.isFinite(end)) &&
        (start === null || end === null || start <= end)
    );
}

export function validateRangeBounds(start: number | null, end: number | null): void {
    if (!areRangeBoundsValid(start, end)) {
        throw new RangeError('Range boundaries must be finite and ordered');
    }
}

export function isRange(value: unknown): value is Range {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const { start, end } = value as Range;

    return (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start <= end
    );
}

export function validateRange(range: Range): void {
    if (!isRange(range)) {
        throw new RangeError('Range boundaries must be finite and ordered');
    }
}

export function equalRanges(left: RangeSet | null, right: RangeSet | null): boolean {
    if (left === right) {
        return true;
    }

    // Compare normalized sets; unrestricted (null) is distinct from explicit empty coverage ([]).
    if (left === null || right === null || left.length !== right.length) {
        return false;
    }

    for (let i = 0; i < left.length; i++) {
        if (left[i].start !== right[i].start || left[i].end !== right[i].end) {
            return false;
        }
    }

    return true;
}

export function normalizeRanges(ranges: RangeSet): RangeSet {
    const result: { start: number; end: number }[] = [];
    const sorted = ranges.slice().sort((left, right) => left.start - right.start);
    let previous: { start: number; end: number } | null = null;

    for (const range of sorted) {
        const { start, end } = range;

        validateRange(range);

        if (start === end) {
            continue;
        }

        if (previous !== null && start <= previous.end) {
            previous.end = Math.max(previous.end, end);
        } else {
            previous = { start, end };
            result.push(previous);
        }
    }

    // Freeze all individual ranges to ensure immutability.
    result.forEach(Object.freeze);

    return Object.freeze(result);
}

export function intersectRanges(ranges: RangeSet, extent: Range): RangeSet {
    return normalizeRanges(ranges.map(range => ({
        start: Math.max(extent.start, Math.min(extent.end, range.start)),
        end: Math.max(extent.start, Math.min(extent.end, range.end))
    })));
}

export class CoordinateFrame extends Observer {
    #origin: number;

    constructor(readonly space: CoordinateSpace, origin = 0) {
        super();

        if (!Number.isFinite(origin)) {
            throw new RangeError('Coordinate origin must be finite');
        }

        this.#origin = origin;
    }

    get origin() {
        return this.#origin;
    }

    setOrigin(origin: number) {
        if (!Number.isFinite(origin)) {
            throw new RangeError('Coordinate origin must be finite');
        }

        if (origin !== this.#origin) {
            this.#origin = origin;
            this.notify();
        }
    }

    rebaseValue(value: number): number {
        if (!Number.isFinite(value)) {
            throw new RangeError('Coordinate must be finite');
        }

        return value - this.#origin;
    }

    resolveValue(value: number): number {
        if (!Number.isFinite(value)) {
            throw new RangeError('Coordinate must be finite');
        }

        return value + this.#origin;
    }

    rebase(ranges: RangeSet): RangeSet {
        return translateRanges(ranges, -this.#origin);
    }

    resolve(ranges: RangeSet): RangeSet {
        return translateRanges(ranges, this.#origin);
    }
}

function translateRanges(ranges: RangeSet, delta: number): RangeSet {
    const translated: Range[] = [];

    for (const { start, end } of ranges) {
        translated.push({ start: start + delta, end: end + delta });
    }

    return normalizeRanges(translated);
}
