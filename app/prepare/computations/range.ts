import { Observer } from './misc.js';
import { CoordinateFrame, normalizeRanges, intersectRanges, equalRanges, type CoordinateSpace, type Range, type RangeSet } from './coordinates.js';

export class RangeSelection extends Observer {
    #ranges: RangeSet | null = null;
    readonly updates = new Observer();

    constructor(readonly space: CoordinateSpace) {
        super();
        Object.defineProperty(this, 'ranges', {
            enumerable: true,
            get: () => this.#ranges
        });
    }

    view(extent: Range, origin = 0) {
        return new RangeView(this, new CoordinateFrame(this.space, origin), extent);
    }

    get ranges() {
        return this.#ranges;
    }

    setRanges(ranges: RangeSet | null) {
        const next = ranges === null ? null : normalizeRanges(ranges);

        if (!equalRanges(next, this.#ranges)) {
            // null is unrestricted; [] is an explicit empty request. Neither is population coverage.
            this.#ranges = next;
            this.notify();
        }

        this.updates.notify();
    }

    setRange(start: number | null, end: number | null) {
        this.setRanges(start === null || end === null ? null : [{ start, end }]);
    }

    resetRange() {
        this.setRange(null, null);
    }
}

export class RangeView {
    readonly extent: Range;

    constructor(readonly selection: RangeSelection, readonly frame: CoordinateFrame, extent: Range) {
        normalizeRanges([extent]);
        // The request is expressed directly in its space; moving this frame must not move that request.
        if (frame.space !== selection.space) {
            throw new Error('Coordinate spaces require an explicit mapping');
        }
        this.extent = Object.freeze({ ...extent });
        // Expose computed properties to Jora without storing competing mutable copies.
        Object.defineProperties(this, {
            ranges: { enumerable: true, get: () => this.requestedRanges() },
            coverage: { enumerable: true, get: () => this.effectiveCoverage() },
            resolvedExtent: { enumerable: true, get: () => this.resolveExtent() }
        });
    }

    get ranges(): RangeSet | null {
        return this.requestedRanges();
    }

    get coverage(): RangeSet {
        return this.effectiveCoverage();
    }

    get resolvedExtent(): Range {
        return this.resolveExtent();
    }

    private resolveExtent(): Range {
        return {
            start: this.frame.resolveValue(this.extent.start),
            end: this.frame.resolveValue(this.extent.end)
        };
    }

    private requestedRanges(): RangeSet | null {
        const { ranges } = this.selection;

        return ranges === null ? null : this.frame.rebase(ranges);
    }

    private effectiveCoverage(): RangeSet {
        return intersectRanges(this.ranges ?? [this.extent], this.extent);
    }

    setRanges(ranges: RangeSet | null) {
        this.selection.setRanges(ranges === null ? null : this.frame.resolve(ranges));
    }

    setRange(start: number | null, end: number | null) {
        this.setRanges(start === null || end === null ? null : [{ start, end }]);
    }

    resetRange() {
        this.selection.resetRange();
    }

    subscribe(callback: () => void) {
        const unsubscribeSelection = this.selection.subscribe(callback);
        const unsubscribeFrame = this.frame.subscribe(callback);

        return () => {
            unsubscribeSelection();
            unsubscribeFrame();
        };
    }
}
