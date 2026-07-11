import { CpuProScript } from '../types';
import { createLineBoundaries } from './line-boundaries.js';
import { createParseWorker } from '../workers/index.js';
import { FunctionRange, FunctionRanges, parseScriptSourceRanges } from './parse-script-source-ranges.js';

const scriptLines = new WeakMap<CpuProScript, ReturnType<typeof createLineBoundaries>>();
const scriptFunctionRanges = new WeakMap<CpuProScript, FunctionRanges>();

function getScriptLineBoundaries(script: CpuProScript | null) {
    if (!script || !script.source) {
        return null;
    }

    let lines = scriptLines.get(script);
    if (!lines) {
        lines = createLineBoundaries(script.source);
        scriptLines.set(script, lines);
    }
    return lines;
}

function getScriptFunctionRanges(script: CpuProScript | null) {
    if (!script || !script.source) {
        return null;
    }

    let functionRanges = scriptFunctionRanges.get(script);
    if (!functionRanges) {
        functionRanges = parseScriptSourceRanges(script.source, script.url);
        scriptFunctionRanges.set(script, functionRanges);
    }

    return functionRanges;
}

function binarySearchFunctionRangeIndex(starts: number[], position: number) {
    let left = 0;
    let right = starts.length - 1;

    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const offset = starts[mid];

        if (offset === position) {
            return mid;
        }

        if (offset < position) {
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }

    return right === -1 ? 0 : right;
}

export function findFunctionAtPosition(functionRanges: FunctionRanges, position: number) {
    let candidate: FunctionRange | null = null;

    if (functionRanges.starts.length > 0) {
        const rangeIndex = binarySearchFunctionRangeIndex(
            functionRanges.starts,
            position
        );

        if (rangeIndex !== -1) {
            const rangeIndex2 = functionRanges.indexes[rangeIndex];

            if (rangeIndex2 !== -1) {
                candidate = functionRanges.ranges[rangeIndex2];
            }

            if ((candidate === null || candidate.start !== position) && rangeIndex > 0) {
                const prevIndex = functionRanges.indexes[rangeIndex - 1];
                if (prevIndex !== -1) {
                    const prevRange = functionRanges.ranges[prevIndex];

                    if (prevRange.end === position) {
                        candidate = prevRange;
                    }
                }
            }
        }
    }

    return candidate;
}
// slow version
// export function findFunctionAtPosition({ ranges }: FunctionRanges, position: number) {
//     let candidate: FunctionRange | null = null;
//     let candidateLength = Infinity;

//     for (const range of ranges) {
//         if (range.start <= position && position <= range.end) {
//             const rangeLength = range.end - range.start;

//             if (rangeLength < candidateLength) {
//                 candidate = range;
//                 candidateLength = rangeLength;
//             }
//         }
//     }

//     return candidate;
// }

export function findFunctionAtLineColumn(functionRanges: FunctionRanges, line: number, column: number) {
    const ranges = functionRanges.ranges;
    let candidate: FunctionRange | null = null;

    for (let i = 0; i < ranges.length; i++) {
        const range = ranges[i];
        const startsBefore = range.startLine < line || (range.startLine === line && range.startColumn <= column);
        const endsAfter = range.endLine > line || (range.endLine === line && range.endColumn >= column);

        if (startsBefore && endsAfter) {
            if (candidate === null || range.end - range.start < candidate.end - candidate.start) {
                candidate = range;
            }
        } else if (!startsBefore) {
            break;
        }
    }

    return candidate;
}

export function getFunctionAtScriptOffset(script: CpuProScript | null, offset: number) {
    const functionRanges = getScriptFunctionRanges(script);

    return functionRanges !== null
        ? findFunctionAtPosition(functionRanges, offset)
        : null;
}

export function getScriptOffsetFromLineColumn(script: CpuProScript | null, line: number, column: number) {
    const lines = getScriptLineBoundaries(script);

    if (lines) {
        return lines.getOffset(line + 1, column + 1);
    }

    return -1;
}

export function getScriptLineColumnFromOffset(script: CpuProScript | null, offset: number) {
    const lines = getScriptLineBoundaries(script);

    if (lines && offset >= 0) {
        return {
            line: lines.getLine(offset) - 1,
            column: lines.getColumn(offset) - 1
        };
    }

    return null;
}

export function getFunctionEndFromScriptLineColumn(script: CpuProScript | null, line: number, column: number) {
    const functionRanges = getScriptFunctionRanges(script);

    if (functionRanges) {
        const func = findFunctionAtLineColumn(functionRanges, line + 1, column + 1);
        // const lines = script._lines ??= createLineBoundaries(script.source);
        // const pos = lines.getOffset(line + 1, column + 1);
        // // const alt = functionRanges.find(fr => fr.start <= pos && pos <= fr.end);
        // let alt = null;
        // for (const fr of functionRanges) {
        //     if (fr.start <= pos && pos <= fr.end) {
        //         alt = !alt ? fr : pos - fr.start < pos - alt.start ? fr : alt;
        //     } else if (alt) {
        //         break;
        //     }
        // }
        // console.log({script, line, column, pos,
        //     // pos0: lines.getOffset(line, column),
        //     // pos11: lines.getOffset(line + 1, column + 1),
        //     // posmm: lines.getOffset(line - 1, column - 1),
        //     alt}, func, fn);

        if (func) {
            return func.end;
        }
    }

    return -1;
}

const parseInWorker = (function createParseInWorker() {
    const workerPool: Worker[] = [];

    return function parseInWorker(payload, onResult) {
        return new Promise<void>((resolve) => {
            let worker = workerPool.pop() || createParseWorker();

            worker.postMessage(payload);
            worker.addEventListener('message', (event) => {
                const { data } = event;

                workerPool.push(worker);
                worker = null as unknown as Worker;

                onResult(data);
                resolve();
            }, { once: true });
        });
    };
}());

export function prepareScriptSources(scripts: CpuProScript[] | Set<CpuProScript>) {
    const scriptsToParse: CpuProScript[] = [];
    let totalSourceSize = 0;

    for (const script of scripts) {
        // Skip scripts that have already been processed
        if (scriptFunctionRanges.has(script)) {
            continue;
        }

        // Skip scripts that are have no source code
        if (!script.source || !script.source.length) {
            continue;
        }

        totalSourceSize += script.source.length;
        scriptsToParse.push(script);
    }

    if (scriptsToParse.length === 0) {
        return Promise.resolve();
    }

    const workerCount = Math.min(
        6,
        scriptsToParse.length,
        Math.ceil(totalSourceSize / 4_000_000),
        Math.max(1, Math.floor(navigator.hardwareConcurrency / 2))
    );

    scriptsToParse.sort((a, b) => b.source!.length - a.source!.length);
    const scriptBuckets: CpuProScript[][] = Array.from({ length: workerCount }, () => []);
    const scriptBucketsSizes: number[] = Array.from({ length: workerCount }, () => 0);
    for (let i = 0; i < scriptsToParse.length; i++) {
        let minBucketIndex = 0;

        for (let j = 1; j < workerCount; j++) {
            if (scriptBucketsSizes[j] < scriptBucketsSizes[minBucketIndex]) {
                minBucketIndex = j;
            }
        }

        scriptBuckets[minBucketIndex].push(scriptsToParse[i]);
        scriptBucketsSizes[minBucketIndex] += scriptsToParse[i].source!.length;
    }

    const result = Promise.all(Array.from({ length: workerCount }, (_, bucketIndex) => {
        const scriptsForWorker = scriptBuckets[bucketIndex];

        return parseInWorker(scriptsForWorker.map(script => ({
            id: script.id,
            url: script.url,
            source: script.source!
        })), (scriptParsedResults) => {
            for (let i = 0; i < scriptParsedResults.length; i++) {
                const ranges = scriptParsedResults[i]?.ranges ?? null;
                const script = scriptsForWorker[i];

                script.sourceFunctionRanges = ranges;
                scriptFunctionRanges.set(script, ranges);
            }
        });
    }));

    return result.then(() => void 0);
}
