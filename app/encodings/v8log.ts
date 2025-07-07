import { consumeV8logStreamLineByLine } from './v8log/consume-v8log-stream.js';
import { processV8logEvents, processV8logRaw } from './v8log/process-v8log-lines.js';

export function decode(iterator: AsyncIterableIterator<Uint8Array> | AsyncIterableIterator<string>) {
    return processV8logEvents(consumeV8logStreamLineByLine(iterator));
}

export function decodeRaw(iterator: AsyncIterableIterator<Uint8Array> | AsyncIterableIterator<string>) {
    return processV8logRaw(consumeV8logStreamLineByLine(iterator));
}
