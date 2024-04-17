import { decode } from './encodings/v8log.js';

const decoder = new TextDecoder();
const prelude = 'v8-version,';

export default [
    {
        name: 'v8log',
        test(chunk) {
            const probe = decoder.decode(chunk.slice(0, prelude.length));
            return probe === prelude;
        },
        streaming: true,
        decode
    }
];
