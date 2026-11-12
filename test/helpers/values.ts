// The sum of numeric values
export function sum(values: ArrayLike<number>) {
    let total = 0;

    for (let i = 0; i < values.length; i++) {
        total += values[i];
    }

    return total;
}

// A deterministic pseudo-random sequence: each call returns the next integer below `max`
export function sequence(seed: number) {
    return (max: number) => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;

        return (seed >>> 8) % max;
    };
}
