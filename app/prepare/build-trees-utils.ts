type NumericArray = number[] | Uint32Array | Uint16Array | Uint8Array;

export function isEqualArrays(a: NumericArray, b: NumericArray) {
    if (a.length !== b.length) {
        return 'bad size';
    }

    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return 'fail on ' + i;
        }
    }

    return 'OK';
}

export function traverseFirstNextTree(firstChild: number[] | Uint32Array, nextSibling: number[] | Uint32Array) {
    const result: number[] = [];
    const stack = [0];
    let cursor = 0;

    while (stack.length > 0) {
        const first = firstChild[cursor];
        const next = nextSibling[cursor];

        if (first && next) {
            stack.push(next);
        }

        result.push(cursor);
        cursor = first || next || stack.pop();
    }

    return result;
}

export function dumpFirstNextTree(firstChild: Uint32Array, nextSibling: Uint32Array, value) {
    const result = [];
    const stack = [0];
    const depths = new Map([[0, 0]]);
    let cursor = 0;

    while (stack.length > 0) {
        const first = firstChild[cursor];
        const next = nextSibling[cursor];
        const depth = depths.get(cursor);

        if (first && next) {
            stack.push(next);
        }

        if (first) {
            depths.set(first, depth + 1);
        }
        if (next) {
            depths.set(next, depth);
        }

        result.push('  '.repeat(depth) + ` #${cursor} -> ${value(cursor)}`);
        cursor = first || next || stack.pop();
    }

    console.log(result.join('\n'));
}

export function checkFirstNextTree(count: number, firstChild: Uint32Array, nextSibling: Uint32Array, dropped: number[]) {
    const traversed = traverseFirstNextTree(firstChild, nextSibling);
    const test = traversed.concat(dropped).sort((a, b) => a - b);
    const unique = new Set(test);
    const result = [];

    if (test.length !== count) {
        result.push(`wrong length, should be ${count} got ${test.length}`);
    }

    if (unique.size !== count) {
        result.push(`contains duplicates, length should be ${count} got ${unique.size}`);
    }

    for (let i = 0; i < test.length - 1; i++) {
        if (test[i] !== test[i + 1] - 1) {
            result.push(`after ${test[i]} should be ${test[i] + 1} but got ${test[i + 1]}`);
            break;
        }
    }

    return result.length ? result : false;
}
