import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../fixtures/profile.js';

function failure(check: () => void) {
    try {
        check();
    } catch (error) {
        return error as assert.AssertionError;
    }

    return null;
}

const shared = { value: 1 };

test.each([
    ['equal numbers', 1, 1, true, true],
    ['NaN', NaN, NaN, true, true],
    ['zeros of different signs', 0, -0, false, false],
    ['the same object', shared, shared, true, true],
    ['equal objects', { value: 1 }, { value: 1 }, false, true],
    ['an array and a typed array', [1, 2], new Uint8Array([1, 2]), false, false],
    ['typed arrays of different types', new Uint8Array([1, 2]), new Uint16Array([1, 2]), false, false],
    ['different nested values', { list: [1, [2]] }, { list: [1, [3]] }, false, false]
])('equality assertions keep the semantics of node:assert/strict: %s', (_, actual, expected, strict, deep) => {
    assert.equal(failure(() => assert.equal(actual, expected)) === null, strict);
    assert.equal(failure(() => assert.strictEqual(actual, expected)) === null, strict);
    assert.equal(failure(() => assert.notEqual(actual, expected)) === null, !strict);
    assert.equal(failure(() => assert.deepEqual(actual, expected)) === null, deep);
    assert.equal(failure(() => assert.notDeepEqual(actual, expected)) === null, !deep);
});

test('a failure keeps the message, describes both values for a line diff and starts its stack at the call', () => {
    const error = failure(() => assert.deepEqual({ list: [1, 2, 3] }, { list: [1, 2, 4] }, 'lists differ'))!;

    assert.equal(error.message, 'lists differ');
    assert.equal(error.actual, '{\n  list: [\n    1,\n    2,\n    3\n  ]\n}');
    assert.equal(error.expected, '{\n  list: [\n    1,\n    2,\n    4\n  ]\n}');
    assert.equal(error.operator, 'deepStrictEqual');
    assert.equal(error.stack!.includes('test/setup/assert.ts'), false);
});

test('an error given as the message is thrown as it is', () => {
    const custom = new Error('custom');

    assert.equal(failure(() => assert.equal(1, 2, custom)), custom);
});

test('failures over profiles are bounded descriptions, and say so when the descriptions are equal', async () => {
    const { profile: first } = await createProfileFixture();
    const { profile: second } = await createProfileFixture();
    const start = performance.now();
    const error = failure(() => assert.equal({ profile: first }, { profile: second }))!;

    // Unbounded, this failure takes more than a second and hundreds of MB
    assert.ok(performance.now() - start < 200);
    assert.ok((error.actual as string).split('\n').length <= 401);
    assert.equal(
        error.message,
        'Expected values to be strictly equal (equal descriptions: the values differ deeper or are different objects)'
    );
});
