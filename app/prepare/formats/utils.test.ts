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

    for (const row of cases) {
        const array = Object.freeze(row.values.slice());
        const typed = Float64Array.from(row.values);

        assert.equal(getNumericArrayOrder(array), row.order);
        assert.equal(getNumericArrayOrder(typed), row.order);
        assert.deepEqual(Array.from(typed), row.values);
    }
});

test('numeric order reads each element once and stops at the first inversion', () => {
    const cases = [
        { values: [10, 11, 12, 13], reads: ['0', '1', '2', '3'] },
        { values: [10, 12, 12, 20], reads: ['0', '1', '2', '3'] },
        { values: [10, 9, 20, 30], reads: ['0', '1'] }
    ];

    for (const row of cases) {
        const reads: string[] = [];
        const input = new Proxy(row.values, {
            get(target, property) {
                if (typeof property === 'string' && /^\d+$/.test(property)) {
                    reads.push(property);
                }

                return Reflect.get(target, property, target);
            }
        });

        getNumericArrayOrder(input);

        assert.deepEqual(reads, row.reads);
    }
});
