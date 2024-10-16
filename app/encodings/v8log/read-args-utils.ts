import { ArgParser } from './types.js';

export function offsetOrEnd(str: string, buffer: string, start = 0, end = buffer.length) {
    const offset = buffer.indexOf(str, start);

    return offset !== -1 && offset < end ? offset : end;
}

export function readArgRaw(buffer: string, start: number, end?: number) {
    end = offsetOrEnd(',', buffer, start, end);
    return buffer.slice(start, end);
}

export function readAllArgsRaw(buffer: string, start: number, end = buffer.length) {
    const args: string[] = [];

    while (start <= end) {
        const arg = readArgRaw(buffer, start, end);

        args.push(arg);
        start += arg.length + 1;
    }

    return args;
}

export function readAllArgs<T extends ArgParser[]>(
    parsers: T,
    buffer: string,
    start: number,
    end?: number
): [...{ [K in keyof T]: ReturnType<T[K]> }, ...string[]] {
    const args = readAllArgsRaw(buffer, start, end);
    const parsedArgs: (string | number)[] = [];

    for (let i = 0; i < parsers.length && i < args.length; i++) {
        parsedArgs.push(parsers[i](args[i]));
    }

    if (parsers.length < args.length) {
        parsedArgs.push(...args.slice(parsers.length));
    }

    return parsedArgs as [...{ [K in keyof T]: ReturnType<T[K]> }, ...string[]];
}

// Helper function to ensure tuple type is preserved
export function argParsers<T extends ArgParser[]>(...args: T): T {
    return args;
}
