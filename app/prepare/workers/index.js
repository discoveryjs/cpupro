import code from './parse-source-worker.js' with { type: 'text', bundle: 'esm' };

function createWorker(code, options) {
    const blob = new Blob([code], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url, options);

    URL.revokeObjectURL(url);

    return worker;
}

export function createParseWorker() {
    return createWorker(code, {
        type: 'module',
        name: 'cpupro-parse-source-worker'
    });
}
