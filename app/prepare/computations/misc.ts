export type Listener = { fn: () => void };
export class Observer {
    #subscriptions: Listener[] = [];

    subscribe(fn: () => void) {
        let listener: Listener | null = { fn };
        this.#subscriptions.push(listener);

        return () => {
            if (listener !== null) {
                this.#subscriptions = this.#subscriptions.filter(el => el !== listener);
                listener = null;
            }
        };
    }

    notify() {
        for (const { fn } of this.#subscriptions) {
            fn();
        }
    }
}

// Jora reads own properties: expose prototype getters as own enumerable properties
export function exposeGetters(target: object, prototype: object, names: string[]) {
    for (let i = 0; i < names.length; i++) {
        const { get } = Object.getOwnPropertyDescriptor(prototype, names[i])!;

        Object.defineProperty(target, names[i], {
            enumerable: true,
            get: get!.bind(target)
        });
    }
}

export function binarySearch(array: Uint32Array, value: number): number {
    let left = 0;
    let right = array.length - 1;

    while (left <= right) {
        const mid = (left + right) >> 1;
        const midValue = array[mid];

        if (midValue === value) {
            return mid;
        }

        if (midValue < value) {
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }

    return right === -1 ? 0 : right;
}

export function lowerBound(values: ArrayLike<number>, value: number, upper = false) {
    let start = 0;
    let end = values.length;

    while (start < end) {
        const middle = (start + end) >>> 1;

        if (upper ? values[middle] <= value : values[middle] < value) {
            start = middle + 1;
        } else {
            end = middle;
        }
    }

    return start;
}

// Starts of the events of every step of nondecreasing values of events: the first event whose value is at least
// so many steps, plus the end of the events for the last step
export function stepStarts(values: Uint32Array | Float64Array, stepCount: number, step: number) {
    const starts = new Uint32Array(stepCount + 1);
    let start = 0;

    // PERF: Steps of nondecreasing values follow each other closely, so the start of a step is searched from the start
    // of the one before it: doubling steps find an end of the search, halving finds the start in it, reading a few
    // values near it rather than all of them
    for (let i = 0; i < stepCount; i++) {
        const threshold = i * step;
        let end = start;
        let size = 1;

        while (end < values.length && values[end] < threshold) {
            start = end + 1;
            end += size;
            size *= 2;
        }

        end = Math.min(end, values.length);

        while (start < end) {
            const middle = (start + end) >>> 1;

            if (values[middle] < threshold) {
                start = middle + 1;
            } else {
                end = middle;
            }
        }

        starts[i] = start;
    }

    starts[stepCount] = values.length;

    return starts;
}
