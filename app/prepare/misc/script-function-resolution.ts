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

type ParseWorkerPayload = Array<{
    id: number;
    url: string;
    source: string;
}>;
type ParseWorkerResult = Array<{
    id: number;
    ranges: FunctionRanges;
}>;
type WorkerEntry = {
    worker: Worker;
    ttl: number;
    finish: Promise<void> | null;
    controller: AbortController | null;
    terminateTimer: ReturnType<typeof setTimeout> | null;
};

const parseWorkerPool = (function createParseWorkerPool() {
    const MAX_WORKERS = Math.min(6, Math.max(1, Math.ceil(navigator.hardwareConcurrency / 2)));
    const WORKER_TTL = 10_000; // 10 seconds
    let workerPool: WorkerEntry[] = [];
    let workerRequestQueue: Array<PromiseWithResolvers<WorkerEntry>> = [];

    async function getWorkerEntry() {
        let entry = workerPool.find(w => !w.controller);

        if (!entry) {
            if (workerPool.length >= MAX_WORKERS) {
                const workerRequest = Promise.withResolvers<WorkerEntry>();

                workerRequestQueue.push(workerRequest);
                entry = await workerRequest.promise;
            } else {
                workerPool.push(entry = {
                    worker: createParseWorker(),
                    ttl: WORKER_TTL,
                    finish: null,
                    controller: null,
                    terminateTimer: null
                });
            }
        }

        if (entry.terminateTimer) {
            clearTimeout(entry.terminateTimer);
        }

        if (!entry.controller) {
            entry.controller = new AbortController();
        }

        return entry;
    }

    function releaseWorkerEntry(entry: WorkerEntry) {
        entry.finish = null;
        entry.controller?.abort();
        entry.controller = null;

        if (workerPool.includes(entry)) {
            const workerRequest = workerRequestQueue.shift();

            if (workerRequest) {
                // assign controller to entry here, since request is resolved via await
                // and can be captured by another request
                entry.controller = new AbortController();
                workerRequest.resolve(entry);
            } else {
                entry.terminateTimer = setTimeout(() => {
                    entry.worker.terminate();
                    workerPool = workerPool.filter(e => e !== entry);
                }, entry.ttl);
            }
        } else {
            entry.worker.terminate();
        }
    }

    return {
        MAX_WORKERS,
        parsingScripts: new WeakSet<CpuProScript>(),

        async parse(payload: ParseWorkerPayload) {
            const entry = await getWorkerEntry();
            const { signal: aboutSignal } = entry.controller!;
            const result = new Promise<ParseWorkerResult>((resolve, reject) => {
                entry.worker.postMessage(payload);
                entry.worker.addEventListener('message', (event) => {
                    resolve(event.data);
                }, { once: true, signal: aboutSignal });
                entry.worker.addEventListener('error', (event) => {
                    reject(new Error(`Worker error: ${event.message}`));
                    event.preventDefault();
                }, { once: true, signal: aboutSignal });
                entry.worker.addEventListener('messageerror', (event) => {
                    reject(new Error(`Worker message error: ${event.data}`));
                }, { once: true, signal: aboutSignal });
                aboutSignal.addEventListener('abort', () => {
                    reject(new Error('Worker request aborted'));
                }, { once: true });
            });

            entry.finish = result.then(
                () => releaseWorkerEntry(entry),
                () => releaseWorkerEntry(entry)
            );

            return result;
        },

        async waitAll() {
            // wait for all reuests to finish, then all workers are idle
            await Promise.all(workerRequestQueue.map(request => request.promise));
            await Promise.all(workerPool.map(entry => entry.finish).filter(Boolean));
        },

        terminate(immediately: boolean = false) {
            const entries = [...workerPool];

            workerPool = [];

            for (const entry of entries) {
                if (entry.terminateTimer) {
                    clearTimeout(entry.terminateTimer);
                }

                if (entry.controller && !immediately) {
                    entry.ttl = 0;
                    workerPool.push(entry);
                } else {
                    releaseWorkerEntry(entry);
                }
            }

            if (immediately) {
                const requests = [...workerRequestQueue];

                workerRequestQueue = [];

                for (const request of requests) {
                    request.reject(new Error('Worker pool terminated'));
                }
            }
        }
    };
}());

export function terminateParseWorkerPool(immediately: boolean = false): void {
    parseWorkerPool.terminate(immediately);
}

export async function prepareScriptSources(scripts: CpuProScript[] | Set<CpuProScript>): Promise<void> {
    const parsingScripts = parseWorkerPool.parsingScripts;
    const scriptsToParse: CpuProScript[] = [];
    let totalSourceSize = 0;

    for (const script of scripts) {
        // Skip scripts that are have no source code
        if (!script.source || !script.source.length) {
            continue;
        }

        // Skip scripts that have already been processed
        if (scriptFunctionRanges.has(script) || parsingScripts.has(script)) {
            continue;
        }

        totalSourceSize += script.source.length;
        scriptsToParse.push(script);
        parsingScripts.add(script);
    }

    if (scriptsToParse.length === 0) {
        return;
    }

    const workerCount = Math.min(
        parseWorkerPool.MAX_WORKERS,
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

    await Promise.all(Array.from({ length: workerCount }, async (_, bucketIndex) => {
        const scriptsForWorker = scriptBuckets[bucketIndex];

        try {
            const scriptParsedResults = await parseWorkerPool.parse(scriptsForWorker.map(script => ({
                id: script.id, // for debugging purposes
                url: script.url,
                source: script.source!
            })));

            for (let i = 0; i < scriptParsedResults.length; i++) {
                const ranges = scriptParsedResults[i].ranges;
                const script = scriptsForWorker[i];

                // FIXME: types will be fixed later
                script.functionRanges = ranges.ranges;
                scriptFunctionRanges.set(script, ranges);
            }
        } finally {
            for (const script of scriptsForWorker) {
                parsingScripts.delete(script);
            }
        }
    }));
}
