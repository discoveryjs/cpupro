import { decode as decodeV8log } from './encodings/v8log.js';
import { decode as decodeHeapSnapshot } from './prepare/formats/heap-snapshot.js';

const textEncoder = new TextEncoder();

function startsWith(prelude) {
    const bytes = textEncoder.encode(prelude);

    return chunk => chunk
        .subarray(0, bytes.length)
        .every((ch, index) => ch === bytes[index]);
}

export default [
    {
        name: 'v8log',
        test: startsWith('v8-version,'),
        streaming: true,
        decode: decodeV8log
    },
    {
        name: 'heap-snapshot',
        test: startsWith('{"snapshot":{"meta":'),
        streaming: true,
        decode: decodeHeapSnapshot
    }
];
