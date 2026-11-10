import assert from 'node:assert/strict';
import { inspect, isDeepStrictEqual } from 'node:util';

// On a failure node:assert inspects both values in full (depth 1000, every array element, getters) and Vitest
// clones and prints them again: for values reaching a profile a single failure takes seconds and hundreds of MB.
// Equality assertions keep their semantics; their failures describe both values at the deepest common depth
// whose description fits FAILURE_LINES, as strings Vitest diffs by lines
const FAILURE_LINES = 400;
const MAX_DEPTH = 12;
const inspectOptions = {
    maxArrayLength: 50,
    maxStringLength: 500,
    compact: false,
    sorted: true
};

type AssertFunction = (actual: unknown, expected: unknown, message?: unknown) => void;

function lineCount(text: string) {
    let count = 1;

    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
        count++;
    }

    return count;
}

function truncateLines(text: string) {
    const lines = text.split('\n');

    if (lines.length <= FAILURE_LINES) {
        return text;
    }

    return lines.slice(0, FAILURE_LINES).join('\n') + `\n... ${lines.length - FAILURE_LINES} more lines`;
}

// Descriptions grow exponentially with depth for object graphs, so the depth grows until a description stops
// changing or exceeds the line limit; both values are described at one depth, so only their differences differ
function describePair(actual: unknown, expected: unknown) {
    let descriptions = [
        inspect(actual, { ...inspectOptions, depth: 0 }),
        inspect(expected, { ...inspectOptions, depth: 0 })
    ];

    for (let depth = 1; depth <= MAX_DEPTH; depth++) {
        const deeper = [
            inspect(actual, { ...inspectOptions, depth }),
            inspect(expected, { ...inspectOptions, depth })
        ];

        if (lineCount(deeper[0]) > FAILURE_LINES || lineCount(deeper[1]) > FAILURE_LINES) {
            break;
        }

        if (deeper[0] === descriptions[0] && deeper[1] === descriptions[1]) {
            break;
        }

        descriptions = deeper;
    }

    return descriptions;
}

function createError(
    message: unknown,
    header: string,
    operator: string,
    stackStartFn: AssertFunction
) {
    if (message instanceof Error) {
        throw message;
    }

    // The constructor inspects actual and expected even with a message, so they are set afterwards
    const error = new assert.AssertionError({
        message: header,
        operator,
        stackStartFn
    });

    error.message = message === undefined ? header : String(message);

    return error;
}

function failEqual(
    actual: unknown,
    expected: unknown,
    message: unknown,
    header: string,
    operator: string,
    stackStartFn: AssertFunction
) {
    const descriptions = describePair(actual, expected);
    const error = createError(message, header, operator, stackStartFn);

    if (descriptions[0] === descriptions[1]) {
        error.message += ' (equal descriptions: the values differ deeper or are different objects)';
    }

    error.actual = truncateLines(descriptions[0]);
    error.expected = truncateLines(descriptions[1]);

    throw error;
}

function failUnequal(
    actual: unknown,
    message: unknown,
    header: string,
    operator: string,
    stackStartFn: AssertFunction
) {
    const error = createError(message, header, operator, stackStartFn);

    error.message += '\n\n' + truncateLines(describePair(actual, actual)[0]);

    throw error;
}

function strictEqual(actual: unknown, expected: unknown, message?: unknown) {
    if (!Object.is(actual, expected)) {
        failEqual(
            actual,
            expected,
            message,
            'Expected values to be strictly equal',
            'strictEqual',
            strictEqual
        );
    }
}

function notStrictEqual(actual: unknown, expected: unknown, message?: unknown) {
    if (Object.is(actual, expected)) {
        failUnequal(
            actual,
            message,
            'Expected "actual" to be strictly unequal to',
            'notStrictEqual',
            notStrictEqual
        );
    }
}

function deepStrictEqual(actual: unknown, expected: unknown, message?: unknown) {
    if (!isDeepStrictEqual(actual, expected)) {
        failEqual(
            actual,
            expected,
            message,
            'Expected values to be strictly deep-equal',
            'deepStrictEqual',
            deepStrictEqual
        );
    }
}

function notDeepStrictEqual(actual: unknown, expected: unknown, message?: unknown) {
    if (isDeepStrictEqual(actual, expected)) {
        failUnequal(
            actual,
            message,
            'Expected "actual" not to be strictly deep-equal to',
            'notDeepStrictEqual',
            notDeepStrictEqual
        );
    }
}

// In node:assert/strict the loose names are the strict assertions
const methods = assert as unknown as Record<string, AssertFunction>;

methods.strictEqual = strictEqual;
methods.equal = strictEqual;
methods.notStrictEqual = notStrictEqual;
methods.notEqual = notStrictEqual;
methods.deepStrictEqual = deepStrictEqual;
methods.deepEqual = deepStrictEqual;
methods.notDeepStrictEqual = notDeepStrictEqual;
methods.notDeepEqual = notDeepStrictEqual;
