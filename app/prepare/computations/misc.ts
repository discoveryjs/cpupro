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
