export function createParseWorker(): never {
    throw new Error('Node profile fixtures must not start a browser parsing worker');
}
