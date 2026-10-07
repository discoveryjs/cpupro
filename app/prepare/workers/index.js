/* eslint-env browser, node */
import code from './parse-source-worker.js' with { type: 'text', bundle: 'esm' };

// Node's worker_threads have no onmessage/postMessage globals that the worker script relies on
const nodeWorkerPrelude = `
const { parentPort } = require('node:worker_threads');

globalThis.onmessage = null;
globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
parentPort.on('message', data => globalThis.onmessage({ data }));
`;

function createWorker(code, options) {
    const blob = new Blob([code], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url, options);

    URL.revokeObjectURL(url);

    return worker;
}

// Exposes a worker_threads Worker as a Web Worker, which the parse worker pool expects
class NodeParseWorker extends EventTarget {
    #worker;

    constructor(code, name) {
        super();

        const { Worker: NodeWorker } = process.getBuiltinModule('node:worker_threads');

        this.#worker = new NodeWorker(nodeWorkerPrelude + code, { eval: true, name });
        this.#worker.on('message', data => this.#dispatchMessage('message', data));
        this.#worker.on('messageerror', error => this.#dispatchMessage('messageerror', error));
        this.#worker.on('error', error => this.#dispatchError(error));
    }

    #dispatchMessage(type, data) {
        this.dispatchEvent(new MessageEvent(type, { data }));
    }

    #dispatchError(error) {
        const event = new Event('error', { cancelable: true });

        this.dispatchEvent(Object.assign(event, { message: error.message }));
    }

    postMessage(data, transfer) {
        this.#worker.postMessage(data, transfer);
    }

    terminate() {
        return this.#worker.terminate();
    }
}

/** @returns {Worker} */
export function createParseWorker() {
    const name = 'cpupro-parse-source-worker';

    return typeof Worker === 'function'
        ? createWorker(code, { name })
        : new NodeParseWorker(code, name);
}
