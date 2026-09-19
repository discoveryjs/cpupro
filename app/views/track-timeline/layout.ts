import type { Span } from './types.js';

const MIN_DURATION = 0.001;
const CHUNK_SIZE = 1024;

export function* layoutSpans(spans: Span[]): Generator<Span[] | null, void> {
    const { starts, ends, byStart, priority } = prepareSpanLayout(spans);
    const nested = yield* layoutNestedSpans(spans, byStart, starts, ends, priority);

    if (nested !== null) {
        yield* nested;
        return;
    }

    const core = yield* findCrossingCore(byStart, starts, ends, priority);

    if (core === null || core.length === spans.length) {
        yield* layoutGeneralSpans(spans, byStart, starts, ends, priority);
        return;
    }

    const assigned = yield* assignCoreTracks(core, starts, ends, priority);

    yield* layoutRemainingSpans(spans, byStart, starts, ends, assigned);
}

function prepareSpanLayout(spans: Span[]) {
    const priority = (left: number, right: number) =>
        durations[right] - durations[left] || left - right;
    const count = spans.length;
    const starts = new Float64Array(count);
    const ends = new Float64Array(count);
    const durations = new Float64Array(count);
    // Keep Array for nearly start-sorted traces: V8 13.6/14.6 Array.sort detects
    // ordered runs, unlike TypedArray.sort(compareFn). The 186k-span fixture
    // needs ~186k vs ~1.59M comparisons. Revisit if V8 makes comparator-based
    // TypedArray sorting adaptive; this is not a general array-access advantage.
    const byStart = new Array<number>(count);

    for (let index = 0; index < count; index++) {
        const { start, end } = spans[index];

        starts[index] = start;
        ends[index] = Math.max(end, start + MIN_DURATION);
        durations[index] = end - start;
        byStart[index] = index;
    }

    byStart.sort((left, right) =>
        starts[left] - starts[right] || priority(left, right)
    );

    return { starts, ends, byStart, priority };
}

function prepareCoreLayout(core: number[], starts: Float64Array, ends: Float64Array) {
    const coreStarts = new Float64Array(core.length);
    const coreEnds = new Float64Array(core.length);
    const coreByStart = new Uint32Array(core.length);

    for (let index = 0; index < core.length; index++) {
        coreStarts[index] = starts[core[index]];
        coreEnds[index] = ends[core[index]];
        coreByStart[index] = index;
    }

    return { coreStarts, coreEnds, coreByStart };
}

function* assignCoreTracks(
    core: number[],
    starts: Float64Array,
    ends: Float64Array,
    priority: (left: number, right: number) => number
): Generator<null, Int32Array> {
    const { coreStarts, coreEnds, coreByStart } = prepareCoreLayout(core, starts, ends);
    const assigned = new Int32Array(starts.length).fill(-1);
    let trackIndex = 0;
    let work = 0;

    for (const track of layoutGeneralSpans(core, coreByStart, coreStarts, coreEnds,
        (left, right) => priority(core[left], core[right]))) {
        if (track === null) {
            yield null;
            continue;
        }

        for (const index of track) {
            assigned[index] = trackIndex;

            if (++work === CHUNK_SIZE) {
                work = 0;
                yield null;
            }
        }

        trackIndex++;
    }

    return assigned;
}

function* layoutRemainingSpans(
    spans: Span[],
    byStart: number[],
    starts: Float64Array,
    ends: Float64Array,
    assigned: Int32Array
): Generator<Span[] | null, void> {
    const tracks: Span[][] = [];
    const trackEnds: number[] = [];
    const stack: number[] = [];
    let work = 0;

    for (const index of byStart) {
        while (stack.length > 0 && ends[stack[stack.length - 1]] <= starts[index]) {
            stack.pop();

            if (++work === CHUNK_SIZE) {
                work = 0;
                yield null;
            }
        }

        let trackIndex = assigned[index];

        if (trackIndex === -1) {
            trackIndex = stack.length > 0 ? assigned[stack[stack.length - 1]] + 1 : 0;

            while (trackIndex < trackEnds.length && trackEnds[trackIndex] > starts[index]) {
                trackIndex++;

                if (++work === CHUNK_SIZE) {
                    work = 0;
                    yield null;
                }
            }

            assigned[index] = trackIndex;
            stack.push(index);
        }

        while (tracks.length <= trackIndex) {
            tracks.push([]);
            trackEnds.push(-Infinity);
        }

        tracks[trackIndex].push(spans[index]);
        trackEnds[trackIndex] = ends[index];

        if (++work === CHUNK_SIZE) {
            work = 0;
            yield null;
        }
    }

    yield* tracks;
}

function* findCrossingCore(
    byStart: number[],
    starts: Float64Array,
    ends: Float64Array,
    priority: (left: number, right: number) => number
): Generator<null, number[] | null> {
    const active: number[] = [];
    const minEnds: number[] = [];
    const lastPriority: number[] = [];
    const marked = new Uint8Array(byStart.length);
    let activeCount = 0;
    let work = 0;

    function push(index: number) {
        const previous = activeCount - 1;

        active[activeCount] = index;
        minEnds[activeCount] = previous < 0 ? ends[index] : Math.min(minEnds[previous], ends[index]);
        lastPriority[activeCount] = previous < 0 || priority(index, lastPriority[previous]) > 0
            ? index
            : lastPriority[previous];
        activeCount++;
    }

    for (const index of byStart) {
        if (ends[index] <= starts[index]) {
            return null;
        }

        while (activeCount > 0 && ends[active[activeCount - 1]] <= starts[index]) {
            activeCount--;

            if (++work === CHUNK_SIZE) {
                work = 0;
                yield null;
            }
        }

        if (activeCount > 0 && minEnds[activeCount - 1] <= starts[index]) {
            const count = activeCount;

            activeCount = 0;

            for (let position = 0; position < count; position++) {
                const other = active[position];

                if (ends[other] > starts[index]) {
                    push(other);
                }

                if (++work === CHUNK_SIZE) {
                    work = 0;
                    yield null;
                }
            }
        }

        const crossing = activeCount > 0 && (
            minEnds[activeCount - 1] < ends[index] || priority(lastPriority[activeCount - 1], index) > 0
        );

        push(index);

        if (crossing) {
            for (let position = 0; position < activeCount; position++) {
                marked[active[position]] = 1;

                if (++work === CHUNK_SIZE) {
                    work = 0;
                    yield null;
                }
            }
        }

        if (++work === CHUNK_SIZE) {
            work = 0;
            yield null;
        }
    }

    const core: number[] = [];

    for (const index of byStart) {
        if (marked[index]) {
            core.push(index);
        }

        if (++work === CHUNK_SIZE) {
            work = 0;
            yield null;
        }
    }

    return core;
}

function* layoutGeneralSpans<T>(
    spans: T[],
    byStart: number[] | Uint32Array,
    starts: Float64Array,
    ends: Float64Array,
    priority: (left: number, right: number) => number
): Generator<T[] | null, void> {
    const count = spans.length;
    const byPriority = byStart.slice().sort(priority);
    const byEnd = byStart.slice().sort((left, right) => ends[left] - ends[right] || priority(right, left));
    const prevStart = new Int32Array(count);
    const nextStart = new Int32Array(count);
    const prevEnd = new Int32Array(count);
    const nextEnd = new Int32Array(count);
    const active = new Uint8Array(count);
    const assigned = new Uint8Array(count);
    let remaining = count;
    let work = 0;

    function remove(index: number) {
        active[index] = 0;

        if (prevStart[index] !== -1) {
            nextStart[prevStart[index]] = nextStart[index];
        }

        if (nextStart[index] !== -1) {
            prevStart[nextStart[index]] = prevStart[index];
        }

        if (prevEnd[index] !== -1) {
            nextEnd[prevEnd[index]] = nextEnd[index];
        }

        if (nextEnd[index] !== -1) {
            prevEnd[nextEnd[index]] = prevEnd[index];
        }
    }

    while (remaining > 0) {
        for (let position = 0; position < remaining; position++) {
            const startIndex = byStart[position];
            const endIndex = byEnd[position];

            prevStart[startIndex] = position > 0 ? byStart[position - 1] : -1;
            nextStart[startIndex] = position + 1 < remaining ? byStart[position + 1] : -1;
            prevEnd[endIndex] = position > 0 ? byEnd[position - 1] : -1;
            nextEnd[endIndex] = position + 1 < remaining ? byEnd[position + 1] : -1;
            active[byPriority[position]] = 1;

            if (++work === CHUNK_SIZE) {
                work = 0;
                yield null;
            }
        }

        for (let position = 0; position < remaining; position++) {
            const index = byPriority[position];

            if (active[index]) {
                assigned[index] = 1;

                for (let candidate = nextStart[index]; candidate !== -1 && starts[candidate] < ends[index];) {
                    const next = nextStart[candidate];

                    if (ends[candidate] > starts[index]) {
                        remove(candidate);
                    }

                    candidate = next;

                    if (++work === CHUNK_SIZE) {
                        work = 0;
                        yield null;
                    }
                }

                for (let candidate = prevEnd[index]; candidate !== -1 && ends[candidate] > starts[index];) {
                    const prev = prevEnd[candidate];

                    if (starts[candidate] < ends[index]) {
                        remove(candidate);
                    }

                    candidate = prev;

                    if (++work === CHUNK_SIZE) {
                        work = 0;
                        yield null;
                    }
                }

                remove(index);
            }

            if (++work === CHUNK_SIZE) {
                work = 0;
                yield null;
            }
        }

        const track: T[] = [];
        let startCount = 0;
        let endCount = 0;
        let priorityCount = 0;

        for (let position = 0; position < remaining; position++) {
            const startIndex = byStart[position];
            const endIndex = byEnd[position];
            const priorityIndex = byPriority[position];

            if (assigned[startIndex]) {
                track.push(spans[startIndex]);
            } else {
                byStart[startCount++] = startIndex;
            }

            if (!assigned[endIndex]) {
                byEnd[endCount++] = endIndex;
            }

            if (!assigned[priorityIndex]) {
                byPriority[priorityCount++] = priorityIndex;
            }

            if (++work === CHUNK_SIZE) {
                work = 0;
                yield null;
            }
        }

        remaining = startCount;

        yield track;
    }
}

function* layoutNestedSpans(
    spans: Span[],
    byStart: number[],
    starts: Float64Array,
    ends: Float64Array,
    priority: (left: number, right: number) => number
): Generator<null, Span[][] | null> {
    const stack: number[] = [];
    const tracks: Span[][] = [];
    let work = 0;

    for (const index of byStart) {
        if (ends[index] <= starts[index]) {
            return null;
        }

        while (stack.length > 0 && ends[stack[stack.length - 1]] <= starts[index]) {
            stack.pop();

            if (++work === CHUNK_SIZE) {
                work = 0;
                yield null;
            }
        }

        if (stack.length > 0) {
            const parent = stack[stack.length - 1];

            if (ends[index] > ends[parent] || priority(parent, index) > 0) {
                return null;
            }
        }

        if (tracks.length === stack.length) {
            tracks.push([]);
        }

        tracks[stack.length].push(spans[index]);
        stack.push(index);

        if (++work === CHUNK_SIZE) {
            work = 0;
            yield null;
        }
    }

    return tracks;
}
