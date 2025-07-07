import { decode } from './encodings/v8log.js';

const prelude = new TextEncoder().encode('v8-version,');

export default [
    {
        name: 'v8log',
        test: chunk => chunk
            .subarray(0, prelude.length)
            .every((ch, index) => ch === prelude[index]),
        streaming: true,
        decode
    }
];
