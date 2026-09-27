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
