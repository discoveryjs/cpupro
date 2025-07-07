import { Code } from './types.js';

const BUCKET_SIZE = 14; // number of bits
const BUCKET_ADDRESS_BASE = 1 << BUCKET_SIZE;

function binarySearchCodeEntryIndex(address: number, entries: BucketCodeEntry[], entryOrNext = false) {
    let lo = 0;
    let hi = entries.length - 1;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const entry = entries[mid];

        if (address < entry.start) {
            // target is entirely to the “left” of this range
            hi = mid - 1;
        } else if (address > entry.end) {
            // target is entirely to the “right” of this range
            lo = mid + 1;
        } else {
            // entry.start <= address <= entry.end
            return mid;
        }
    }

    return entryOrNext && lo < entries.length ? lo : -1;
}

function setBucketCodeEntry(bucket: BucketCodeEntry[], bucketCodeEntry: BucketCodeEntry) {
    const { start: address } = bucketCodeEntry;

    // fast path
    if (bucket.length === 0 || address > bucket[bucket.length - 1].end) {
        bucket.push(bucketCodeEntry);
        return;
    }

    const addressEnd = address + bucketCodeEntry.size - 1;

    // fast path
    if (addressEnd < bucket[0].start) {
        bucket.unshift(bucketCodeEntry);
        return;
    }

    const firstInNewRangeEntryIndex = binarySearchCodeEntryIndex(address, bucket, true);
    const firstEntry = bucket[firstInNewRangeEntryIndex];

    if (addressEnd > firstEntry.start) {
        let lastInNewRangeEntryIndex = firstInNewRangeEntryIndex;
        for (; lastInNewRangeEntryIndex + 1 < bucket.length; lastInNewRangeEntryIndex++) {
            if (bucket[lastInNewRangeEntryIndex + 1].start > addressEnd) {
                break;
            }
        }

        bucket.splice(firstInNewRangeEntryIndex, lastInNewRangeEntryIndex - firstInNewRangeEntryIndex + 1, bucketCodeEntry);
    } else {
        bucket.splice(firstInNewRangeEntryIndex, 0, bucketCodeEntry);
    }
}

export class CodeEntry {
    id: number;
    start: number;
    end: number;
    size: number;
    code: Code;

    constructor(id: number, start: number, size: number, code: Code) {
        this.id = id;
        this.start = start;
        this.end = start + size - 1;
        this.size = size;
        this.code = code;
    }

    contains(address: number) {
        return address === this.start || (address > this.start && address <= this.end);
    }

    clone(newAddress: number) {
        return new CodeEntry(this.id, newAddress, this.size, this.code);
    }
}

class BucketCodeEntry {
    start: number;
    size: number;
    end: number;
    codeEntry: CodeEntry;

    constructor(start: number, size: number, codeEntry: CodeEntry) {
        this.start = start;
        this.size = size;
        this.end = start + size - 1;
        this.codeEntry = codeEntry;
    }
}

export class CodeMap {
    codeMemoryBuckets: Map<number, BucketCodeEntry[]>;
    lastCodeEntry: CodeEntry | null;

    constructor() {
        this.codeMemoryBuckets = new Map();
        this.lastCodeEntry = null;
    }

    add(codeEntry: CodeEntry) {
        let { start: address, size } = codeEntry;

        this.lastCodeEntry = codeEntry;

        while (size > 0) {
            const codeEntryBucketAddress = address % BUCKET_ADDRESS_BASE;
            const codeEntryBucketSize = Math.min(size, BUCKET_ADDRESS_BASE - codeEntryBucketAddress);
            const bucketId = address - codeEntryBucketAddress;
            const bucketCodeEntry = new BucketCodeEntry(codeEntryBucketAddress, codeEntryBucketSize, codeEntry);

            if (codeEntryBucketSize === BUCKET_ADDRESS_BASE) {
                this.codeMemoryBuckets.set(bucketId, [bucketCodeEntry]);
            } else {
                let bucket = this.codeMemoryBuckets.get(bucketId);

                if (bucket === undefined) {
                    this.codeMemoryBuckets.set(bucketId, bucket = []);
                }

                setBucketCodeEntry(bucket, bucketCodeEntry);
            }

            address += codeEntryBucketSize;
            size -= codeEntryBucketSize;
        }
    }

    findByAddress(address: number, entryOrNext = false): CodeEntry | null {
        // fast path
        const lastCodeEntry = this.lastCodeEntry;
        if (lastCodeEntry !== null && lastCodeEntry.contains(address)) {
            return lastCodeEntry;
        }

        const codeEntryBucketAddress = address % BUCKET_ADDRESS_BASE;
        const bucketId = address - codeEntryBucketAddress;
        const bucket = this.codeMemoryBuckets.get(bucketId);

        if (bucket === undefined) {
            return null;
        }

        const index = binarySearchCodeEntryIndex(codeEntryBucketAddress, bucket, entryOrNext);

        return index !== -1
            ? bucket[index].codeEntry
            : null;
    }

    resolveStack(
        pc: number,
        func: number,
        stack: (number | string)[]
    ) {
        // "overflow" marker, means that a profiler skipped some samples
        // because of sample buffer overflow;
        // just ignore marker for now
        const startIndex = stack.length > 0 && stack[0] === 'overflow' ? 1 : 0;
        const resolvedStack: number[] = new Array(2 * (stack.length - startIndex + (func ? 2 : 1)));
        let resolvedStackCursor = 0;
        const pushStackEntry = (address: number) => {
            const codeEntry = this.findByAddress(address);

            if (codeEntry !== null) {
                resolvedStack[resolvedStackCursor++] = codeEntry.id;
                resolvedStack[resolvedStackCursor++] = address - codeEntry.start;
            } else {
                resolvedStack[resolvedStackCursor++] = -1;
                resolvedStack[resolvedStackCursor++] = address;
            }
        };

        pushStackEntry(pc);

        if (func) {
            pushStackEntry(func);
        }

        for (let i = startIndex; i < stack.length; i++) {
            const frame = stack[i];

            if (typeof frame === 'number') {
                pushStackEntry(frame);
            } else {
                switch (frame.charCodeAt(0)) {
                    case 43: // +
                    case 45: // -
                        pushStackEntry(pc += parseInt(frame));
                        break;

                    default:
                        pushStackEntry(parseInt(frame));
                }
            }
        }

        return resolvedStack;
    }
}
