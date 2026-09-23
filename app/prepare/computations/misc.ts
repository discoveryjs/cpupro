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

export type NumericArrayOrder = 'consecutive' | 'ascending' | 'unordered';

// Consecutive values have a step of one; ascending values may include gaps or repeats.
export function getNumericArrayOrder(values: ArrayLike<number>): NumericArrayOrder {
    let consecutive = true;
    let previous = values[0] ?? 0;

    for (let index = 1; index < values.length; index++) {
        const current = values[index];

        if (current < previous) {
            return 'unordered';
        }

        if (current !== previous + 1) {
            consecutive = false;
        }

        previous = current;
    }

    return consecutive ? 'consecutive' : 'ascending';
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
