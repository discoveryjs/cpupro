export const GREATEST_LOWER_BOUND = 1;
export const LEAST_UPPER_BOUND = 2;

// TODO: rewrite using a loop
/**
 * Recursive implementation of binary search.
 *
 * @param low Indices here and lower do not contain the needle.
 * @param high Indices here and higher do not contain the needle.
 * @param needle The element being searched for.
 * @param array The non-empty array being searched.
 * @param compare Function which takes two elements and returns -1, 0, or 1.
 * @param bias Either 'binarySearch.GREATEST_LOWER_BOUND' or
 *     'binarySearch.LEAST_UPPER_BOUND'. Specifies whether to return the
 *     closest element that is smaller than or greater than the one we are
 *     searching for, respectively, if the exact element cannot be found.
 */
function searchIndex(low, high, needle, array, compare, bias) {
    while (high - low > 1) {
        const mid = (low + high) >> 1; // Math.floor((high + low) / 2)
        const cmp = compare(needle, array[mid]);

        if (cmp === 0) {
            // Found the element we are looking for.
            return mid;
        }

        if (cmp > 0) {
            low = mid;
        } else {
            high = mid;
        }
    }

    return bias === LEAST_UPPER_BOUND
        ? (high < array.length ? high : -1)
        : (low >= 0 ? low : -1);
}

/**
 * This is an implementation of binary search which will always try and return
 * the index of the closest element if there is no exact hit. This is because
 * mappings between original and generated line/col pairs are single points,
 * and there is an implicit region between each of them, so a miss just means
 * that you aren't on the very start of a region.
 *
 * @param needle The element you are looking for.
 * @param array The array that is being searched.
 * @param compare A function which takes the needle and an element in the
 *     array and returns -1, 0, or 1 depending on whether the needle is less
 *     than, equal to, or greater than the element, respectively.
 * @param bias Either 'binarySearch.GREATEST_LOWER_BOUND' or
 *     'binarySearch.LEAST_UPPER_BOUND'. Specifies whether to return the
 *     closest element that is smaller than or greater than the one we are
 *     searching for, respectively, if the exact element cannot be found.
 *     Defaults to 'binarySearch.GREATEST_LOWER_BOUND'.
 */
export function search(needle, array, compare, bias = GREATEST_LOWER_BOUND) {
    let index = searchIndex(
        -1,
        array.length,
        needle,
        array,
        compare,
        bias
    );

    // We have found either the exact element, or the next-closest element than
    // the one we are searching for. However, there may be more than one such
    // element. Make sure we always return the smallest of these.
    for (; index - 1 >= 0; index--) {
        if (compare(array[index], array[index - 1]) !== 0) {
            break;
        }
    }

    return index;
}
