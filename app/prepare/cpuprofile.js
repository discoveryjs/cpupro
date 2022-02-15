function isObject(value) {
    return typeof value === 'object' && value !== null;
}

function isNode(value) {
    if (!isObject(value)) {
        return false;
    }

    if (typeof value.id !== 'number') {
        return false;
    }

    if (!isObject(value.callFrame) || Number.isInteger(value.callFrame.id)) {
        return false;
    }

    return true;
}

function isArrayLike(value, checkFirst) {
    if (!Array.isArray(value)) {
        return false;
    }

    return value.length > 0
        ? checkFirst(value[0])
        : true;
}

export function isCPUProfile(data) {
    if (!isObject(data)) {
        return false;
    }

    if (!isArrayLike(data.nodes, isNode)) {
        return false;
    }

    if (!isArrayLike(data.samples, Number.isInteger)) {
        return false;
    }

    if (!isArrayLike(data.timeDeltas, Number.isInteger)) {
        return false;
    }

    return true;
}
