import type { FunctionRanges } from './parse-script-source-ranges.js';

export type SourceMetrics = {
    bytesPerChar: 1 | 2;
    byteLength: number;
    nonLatin1CodeUnits: number;
    surrogatePairs: number;
    selfSize: number | null;
};

export function computeScriptSourceMetrics(code: string | null, functionRanges?: FunctionRanges['ranges'] | null): SourceMetrics | null {
    if (code === null) {
        return null;
    }

    let nonLatin1CodeUnits = 0;
    let bytesPerChar: 1 | 2 = 1;
    let surrogatePairs = 0;
    let previous = 0;
    let selfSize: number | null = null;

    if (/[^\x00-\xFF]/.test(code)) {
        for (let index = 0; index < code.length; index++) {
            const current = code.charCodeAt(index);

            if (current > 255) {
                nonLatin1CodeUnits++;
                bytesPerChar = 2;

                if (previous >= 0xd800 &&
                    previous <= 0xdbff &&
                    current >= 0xdc00 &&
                    current <= 0xdfff) {
                    surrogatePairs++;
                }
            }

            previous = current;
        }
    }

    if (functionRanges) {
        selfSize = code.length;

        for (let i = 0; i < functionRanges.length; i++) {
            selfSize -= functionRanges[i].selfSize;
        }
    }

    return {
        bytesPerChar,
        byteLength: code.length * bytesPerChar,
        nonLatin1CodeUnits,
        surrogatePairs,
        selfSize
    };
}
