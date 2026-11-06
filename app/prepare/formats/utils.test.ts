import assert from 'node:assert/strict';
import { test } from 'vitest';
import { getNumericArrayOrder } from './utils.js';

test('numeric order classifies arrays and typed arrays without mutation', () => {
    const cases = [
        { values: [], order: 'consecutive' },
        { values: [10], order: 'consecutive' },
        { values: [-2, -1, 0], order: 'consecutive' },
        { values: [0.5, 1.5, 2.5], order: 'consecutive' },
        { values: [10, 12, 15], order: 'ascending' },
        { values: [10, 10, 11], order: 'ascending' },
        { values: [10, 12, 11], order: 'unordered' }
    ];

    for (const { values, order } of cases) {
        const array = Object.freeze(values.slice());
        const typed = Float64Array.from(values);

        assert.equal(getNumericArrayOrder(array), order);
        assert.equal(getNumericArrayOrder(typed), order);
        assert.deepEqual(Array.from(typed), values);
    }
});

test('numeric order reads each element once and stops at the first inversion', () => {
    for (const values of [[10, 11, 12, 13], [10, 12, 12, 20], [10, 9, 20, 30]]) {
        const reads: string[] = [];
        const input = new Proxy(values, {
            get(target, property) {
                if (typeof property === 'string' && /^\d+$/.test(property)) {
                    reads.push(property);
                }

                return Reflect.get(target, property, target);
            }
        });

        getNumericArrayOrder(input);

        assert.deepEqual(reads, values[1] < values[0] ? ['0', '1'] : ['0', '1', '2', '3']);
    }
});
