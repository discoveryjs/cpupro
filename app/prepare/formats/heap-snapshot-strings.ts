import { exposeGetters } from '../computations/misc.js';

const textDecoder = new TextDecoder();

// The strings section of a heap snapshot kept as its bytes, JSON strings separated by commas: a string is decoded
// when it's taken, all of them when `values` is read. PERF: Decoding the strings of a snapshot of tens of millions
// of objects takes hundreds of ms and hundreds of MB of heap, while views take a small part of them
export class HeapSnapshotStrings {
    readonly bytes: Uint8Array;   // the section between its brackets
    readonly starts: Uint32Array; // per string: the offset of its first byte after the opening quote
    #values: WeakRef<string[]> | null = null;

    constructor(bytes: Uint8Array, starts: Uint32Array) {
        this.bytes = bytes;
        this.starts = starts;

        exposeGetters(this, HeapSnapshotStrings.prototype, ['values']);
    }

    get length() {
        return this.starts.length;
    }

    get(index: number): string {
        const bytes = this.bytes;
        const start = this.starts[index];
        let end = start;

        // an escaped byte is skipped with its "\"
        while (bytes[end] !== 34 /* " */) {
            end += bytes[end] === 92 /* \ */
                ? 2
                : 1;
        }

        const text = textDecoder.decode(bytes.subarray(start, end));

        return text.includes('\\')
            ? JSON.parse('"' + text + '"')
            : text;
    }

    // Kept while something holds them
    get values(): string[] {
        let values = this.#values?.deref();

        if (values === undefined) {
            values = JSON.parse('[' + textDecoder.decode(this.bytes) + ']') as string[];
            this.#values = new WeakRef(values);
        }

        return values;
    }
}
