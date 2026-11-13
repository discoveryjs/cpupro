import { CpuProCallFrame, CpuProScript } from '../types';
import { type Diagnose, diagnoseToConsole } from '../diagnostics.js';
import { createLineBoundaries } from './line-boundaries.js';
import { computeScriptSourceMetrics, type SourceMetrics } from './source-text-metrics.js';
import { createParseWorker } from '../workers/index.js';
import {
    FunctionRange,
    FunctionRangeColumns,
    FunctionRanges,
    parseScriptSourceRanges,
    readFunctionRanges
} from './parse-script-source-ranges.js';
import { ParseSourceWorkerScriptResult } from '../workers/types';

const scriptLines = new WeakMap<CpuProScript, ReturnType<typeof createLineBoundaries>>();
const scriptFunctionRanges = new WeakMap<CpuProScript, FunctionRanges>();
const scriptMaxFunctionPrelude = new WeakMap<CpuProScript, number>();

export function getScriptLineBoundaries(script: CpuProScript | null) {
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

// Releases the line boundaries of scripts whose lines and columns are no longer mapped to offsets;
// a later reader creates them again from the source
export function releaseScriptLineBoundaries(scripts: CpuProScript[]) {
    for (let i = 0; i < scripts.length; i++) {
        scriptLines.delete(scripts[i]);
    }
}

function getScriptFunctionRanges(script: CpuProScript | null) {
    if (!script || script.source === null) {
        return null;
    }

    let functionRanges = scriptFunctionRanges.get(script);
    if (!functionRanges) {
        functionRanges = parseScriptSourceRanges(script.source, script.url);
        setScriptFunctionRanges(script, functionRanges);
    }

    return functionRanges;
}

function setScriptFunctionRanges(
    script: CpuProScript,
    ranges: FunctionRanges,
    diagnose: Diagnose = diagnoseToConsole,
    sourceMetrics: SourceMetrics | null = null // computed from the ranges when not given
) {
    const parsedRanges = ranges.parsed
        ? ranges.ranges
        : null;

    if (ranges.error !== undefined) {
        diagnose('error', 'Failed to parse script for function ranges', {
            scriptId: script.id,
            url: script.url,
            error: ranges.error
        });
    }

    script.functionRanges = parsedRanges;
    script.sourceMetrics = sourceMetrics ?? computeScriptSourceMetrics(script.source, parsedRanges);
    scriptFunctionRanges.set(script, ranges);
    let maxPrelude = 0;

    for (let i = 0; i < ranges.ranges.length; i++) {
        const range = ranges.ranges[i];

        maxPrelude = Math.max(maxPrelude, range.callFrameStart - range.start);
    }

    scriptMaxFunctionPrelude.set(script, maxPrelude);
}

function binarySearchFunctionRangeIndex(starts: Uint32Array<ArrayBuffer>, position: number) {
    let left = 0;
    let right = starts.length - 1;

    while (left <= right) {
        const mid = (left + right) >>> 1;
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

    return right;
}

export function findFunctionAtPosition(functionRanges: FunctionRanges, position: number) {
    return functionAtBoundary(
        functionRanges,
        binarySearchFunctionRangeIndex(functionRanges.starts, position),
        position
    );
}

// The function at a position, given the last boundary at or before the position (-1 when there is none)
function functionAtBoundary(functionRanges: FunctionRanges, rangeIndex: number, position: number) {
    const { indexes, ranges } = functionRanges;
    let candidate: FunctionRange | null = null;

    if (rangeIndex !== -1) {
        const rangeIndex2 = indexes[rangeIndex];

        if (rangeIndex2 !== -1) {
            candidate = ranges[rangeIndex2];
        }

        if ((candidate === null || candidate.callFrameStart !== position) && rangeIndex > 0) {
            const prevIndex = indexes[rangeIndex - 1];

            if (prevIndex !== -1) {
                const prevRange = ranges[prevIndex];

                if (prevRange.end === position) {
                    candidate = prevRange;
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
//         if (range.callFrameStart <= position && position <= range.end) {
//             const rangeLength = range.end - range.callFrameStart;

//             if (rangeLength < candidateLength) {
//                 candidate = range;
//                 candidateLength = rangeLength;
//             }
//         }
//     }

//     return candidate;
// }

export function getFunctionAtScriptOffset(script: CpuProScript | null, offset: number) {
    const functionRanges = getScriptFunctionRanges(script);

    return functionRanges !== null
        ? findFunctionAtPosition(functionRanges, offset)
        : null;
}

// Functions at ascending offsets of a script, as getFunctionAtScriptOffset() finds them: range boundaries
// strictly ascend, so the last boundary at or before each offset is found by a single walk over them
export function getFunctionsAtScriptOffsets(script: CpuProScript | null, offsets: ArrayLike<number>) {
    const functionRanges = getScriptFunctionRanges(script);
    const functions: (FunctionRange | null)[] = new Array(offsets.length).fill(null);

    if (functionRanges !== null) {
        const { starts } = functionRanges;
        let rangeIndex = -1;

        for (let i = 0; i < offsets.length; i++) {
            const offset = offsets[i];

            while (rangeIndex + 1 < starts.length && starts[rangeIndex + 1] <= offset) {
                rangeIndex++;
            }

            functions[i] = functionAtBoundary(functionRanges, rangeIndex, offset);
        }
    }

    return functions;
}

export function getFunctionAtSourceLineColumn(script: CpuProScript, line: number, column: number) {
    const position = getScriptOffsetFromLineColumn(script, line, column);
    const functionRanges = getScriptFunctionRanges(script);
    let candidate: FunctionRange | null = null;

    if (position !== -1 && functionRanges?.parsed) {
        const { starts, indexes, ranges } = functionRanges;
        const rangeIndex = binarySearchFunctionRangeIndex(starts, position);
        const lastStart = position + scriptMaxFunctionPrelude.get(script)!;
        const candidateIndex = rangeIndex !== -1
            ? indexes[rangeIndex]
            : -1;

        if (candidateIndex !== -1) {
            candidate = ranges[candidateIndex];
        }

        for (let i = rangeIndex + 1; i < starts.length && starts[i] <= lastStart; i++) {
            const index = indexes[i];

            if (index !== -1) {
                const range = ranges[index];

                if (range.callFrameStart === starts[i] &&
                    range.start <= position &&
                    position < range.end
                ) {
                    if (candidate === null ||
                        range.end - range.start < candidate.end - candidate.start
                    ) {
                        candidate = range;
                    }
                }
            }
        }
    }

    return candidate;
}

export function matchCallFrameIdentity(
    callFrame: CpuProCallFrame,
    identity: Pick<CpuProCallFrame, 'script' | 'start' | 'end' | 'line' | 'column'>
): 'exact' | 'default-constructor' | null {
    const { script, start, end, line, column } = identity;

    if (script === null || callFrame.script !== script ||
        !Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end < start ||
        !Number.isInteger(line) || line < 0 || !Number.isInteger(column) || column < 0 ||
        callFrame.start !== start || callFrame.line !== line || callFrame.column !== column) {
        return null;
    }

    if (callFrame.end === end) {
        return 'exact';
    }

    if (end === start && callFrame.kind === 'function') {
        const functionRanges = getScriptFunctionRanges(script);
        const range = functionRanges?.parsed === true
            ? findFunctionAtPosition(functionRanges, start)
            : null;

        if (range !== null &&
            range.defaultConstructor === true &&
            range.callFrameStart === start &&
            range.end === callFrame.end &&
            range.callFrameStartLine - 1 === line &&
            range.callFrameStartColumn === column
        ) {
            return 'default-constructor';
        }
    }

    return null;
}

export function isScriptTopLevelOffset(script: CpuProScript, offset: number): boolean {
    if (!Number.isInteger(offset) || offset < 0 || script.source === null || offset > script.source.length) {
        return false;
    }

    const functionRanges = getScriptFunctionRanges(script);

    if (functionRanges?.parsed === true) {
        return findFunctionAtPosition(functionRanges, offset) === null;
    }

    return false;
}

export function getScriptOffsetFromLineColumn(script: CpuProScript | null, line: number, column: number) {
    const lines = getScriptLineBoundaries(script);

    if (lines) {
        return lines.offsetOf(line, column);
    }

    return -1;
}

export function getScriptLineColumnFromOffset(script: CpuProScript | null, offset: number) {
    const lines = getScriptLineBoundaries(script);

    if (lines && offset >= 0) {
        const line = lines.lineOf(offset);

        return {
            line,
            column: lines.columnOf(offset, line)
        };
    }

    return null;
}

export function getFunctionEndFromScriptLineColumn(script: CpuProScript | null, line: number, column: number) {
    const functionRanges = getScriptFunctionRanges(script);

    if (functionRanges) {
        // V8 positions are 0-based lines and columns of the start of a function
        const func = findFunctionAtPosition(functionRanges, getScriptOffsetFromLineColumn(script, line, column));
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
type ParseWorkerResult = {
    scripts: ParseSourceWorkerScriptResult[];
    ranges: FunctionRangeColumns;
    starts: Uint32Array<ArrayBuffer>;
    indexes: Int32Array<ArrayBuffer>;
    lineStarts: Uint32Array;
    types: string[];
};
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
        parsingScripts: new WeakMap<CpuProScript, Promise<void>>(),

        idleWorkerCount() {
            let count = 0;

            for (const entry of workerPool) {
                if (!entry.controller) {
                    count++;
                }
            }

            return count;
        },

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

export async function prepareScriptSources(
    scripts: CpuProScript[] | Set<CpuProScript>,
    diagnose: Diagnose = diagnoseToConsole
): Promise<void> {
    const parsingScripts = parseWorkerPool.parsingScripts;
    const scriptsToParse: CpuProScript[] = [];
    const pending = new Set<Promise<void>>();
    let totalSourceSize = 0;

    for (const script of scripts) {
        const parsing = parsingScripts.get(script);

        // Skip scripts that are have no source code
        if (script.source === null) {
            continue;
        }

        // Skip scripts that have already been processed
        if (scriptFunctionRanges.has(script)) {
            continue;
        }

        if (parsing) {
            pending.add(parsing);
            continue;
        }

        if (script.source.length === 0) {
            setScriptFunctionRanges(script, parseScriptSourceRanges('', script.url, true));
            continue;
        }

        totalSourceSize += script.source.length;
        scriptsToParse.push(script);
    }

    if (scriptsToParse.length === 0) {
        await Promise.all(pending);
        return;
    }

    // A new worker pays off only for a large enough payload (startup and a cold parser),
    // while idle workers already in the pool are free to use
    const workerCount = Math.min(
        parseWorkerPool.MAX_WORKERS,
        scriptsToParse.length,
        Math.max(1, parseWorkerPool.idleWorkerCount(), Math.ceil(totalSourceSize / 4_000_000)),
        Math.max(1, Math.floor(navigator.hardwareConcurrency / 2))
    );
    const buckets = distributeScriptsBySourceSize(scriptsToParse, workerCount);

    for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i];
        // the parsing runs synchronously up to its first await, so the registration precedes its cleanup
        const parsing = parseScriptBucket(bucket, diagnose);

        pending.add(parsing);

        for (let j = 0; j < bucket.length; j++) {
            parsingScripts.set(bucket[j], parsing);
        }
    }

    await Promise.all(pending);
}

// Scripts go one by one, the largest first, into the bucket of the smallest source size,
// so the buckets of the parse workers get about equal sizes
function distributeScriptsBySourceSize(scripts: CpuProScript[], bucketCount: number) {
    const bySourceSizeDesc = (a: CpuProScript, b: CpuProScript) => b.source!.length - a.source!.length;
    const buckets: CpuProScript[][] = [];
    const bucketSizes = new Float64Array(bucketCount);

    for (let i = 0; i < bucketCount; i++) {
        buckets.push([]);
    }

    scripts.sort(bySourceSizeDesc);

    for (let i = 0; i < scripts.length; i++) {
        let smallestBucket = 0;

        for (let j = 1; j < bucketCount; j++) {
            if (bucketSizes[j] < bucketSizes[smallestBucket]) {
                smallestBucket = j;
            }
        }

        buckets[smallestBucket].push(scripts[i]);
        bucketSizes[smallestBucket] += scripts[i].source!.length;
    }

    return buckets;
}

// Parses the sources of a bucket of scripts in a parse worker
// and sets the function ranges and line boundaries of the scripts
async function parseScriptBucket(scripts: CpuProScript[], diagnose: Diagnose) {
    const toPayload = (script: CpuProScript) => ({
        id: script.id, // for debugging purposes
        url: script.url,
        source: script.source!
    });

    try {
        const result = await parseWorkerPool.parse(scripts.map(toPayload));
        const {
            scripts: scriptParsedResults,
            ranges: rangeColumns,
            starts,
            indexes,
            lineStarts,
            types
        } = result;
        let rangeOffset = 0;
        let indexOffset = 0;
        let lineOffset = 0;

        for (let i = 0; i < scriptParsedResults.length; i++) {
            const { sourceMetrics, parsed, error, rangeCount, indexCount, lineCount } = scriptParsedResults[i];
            const script = scripts[i];
            const scriptLineStarts = lineStarts.subarray(lineOffset, lineOffset + lineCount);
            const ranges: FunctionRanges = {
                parsed,
                ranges: readFunctionRanges(rangeColumns, rangeOffset, rangeCount, types),
                starts: starts.subarray(indexOffset, indexOffset + indexCount),
                indexes: indexes.subarray(indexOffset, indexOffset + indexCount)
            };

            if (error !== undefined) {
                ranges.error = error;
            }

            rangeOffset += rangeCount;
            indexOffset += indexCount;
            lineOffset += lineCount;
            setScriptFunctionRanges(script, ranges, diagnose, sourceMetrics);
            scriptLines.set(script, createLineBoundaries(script.source!, scriptLineStarts));
        }
    } finally {
        for (let i = 0; i < scripts.length; i++) {
            parseWorkerPool.parsingScripts.delete(scripts[i]);
        }
    }
}
