import { argParsers, offsetOrEnd, readAllArgs, readAllArgsRaw } from './v8log/read-args-utils.js';
import { detachSlicedString, parseAddress, parseStack, parseCodeState, parseString, parseICState } from './v8log/parse-utils.js';
import { Code, CodeCompiled, CodeJavaScript, CodeSharedLib, Heap, HeapEvent, ICEntry, LogFunction, Meta, ParseResult, Script, SFI, Tick } from './v8log/types.js';

const decoder = new TextDecoder();

const icEntryParsers = argParsers(/* pc */ parseString, /* tm */ parseInt, /* line */ parseInt,
    /* colum */ parseInt, /* old_state */ parseString, /* new_state */ parseString,
    /* mapId */ parseString, /* key */ parseString, /* modifier */ parseString, /* slow_reason*/ parseString);
const parsers = {
    'profiler': argParsers(parseString, parseInt),
    'heap-capacity': argParsers(parseInt),
    'heap-available': argParsers(parseInt),
    'new': argParsers(parseString, parseString, parseInt),
    'delete': argParsers(parseString, parseString),
    'script-source': argParsers(parseInt, parseString, parseString),
    'shared-library': argParsers(parseString, parseAddress, parseAddress, parseAddress),
    'code-creation': argParsers(parseString, parseInt, parseInt, parseAddress, parseAddress, parseString),
    'code-move': argParsers(parseAddress, parseAddress),
    'code-deopt': argParsers(parseInt, parseInt, parseAddress, parseInt, parseInt, parseString, parseString, parseString),
    'sfi-move': argParsers(parseString, parseString),
    'code-delete': argParsers(parseAddress),
    'code-source-info': argParsers(parseAddress, parseInt, parseInt, parseInt, parseString, parseString, parseString),
    'code-disassemble': argParsers(parseAddress, parseString, parseString),
    'tick': argParsers(parseAddress, parseInt, parseInt, parseAddress, parseInt),
    'LoadIC': icEntryParsers,
    'StoreIC': icEntryParsers,
    'KeyedLoadIC': icEntryParsers,
    'KeyedStoreIC': icEntryParsers,
    'LoadGlobalIC': icEntryParsers,
    'StoreGlobalIC': icEntryParsers,
    'StoreInArrayLiteralIC': icEntryParsers
} as const;

class CodeEntry {
    id: number;
    start: number;
    size: number;
    end: number;
    code: Code;
    constructor(id: number, start: number, size: number, code: Code) {
        this.id = id;
        this.start = start;
        this.size = size;
        this.end = start + size - 1;
        this.code = code;
    }
    contains(address: number) {
        return address >= this.start && address <= this.end;
    }
    clone(newAddress: number) {
        return new CodeEntry(this.id, newAddress, this.size, this.code);
    }
}

class BucketCodeEntry {
    start: number;
    size: number;
    end: number;
    codeEntry: CodeEntry;
    constructor(start: number, size: number, codeEntry: CodeEntry) {
        this.start = start;
        this.size = size;
        this.end = start + size - 1;
        this.codeEntry = codeEntry;
    }
}

function findNewline(str: string, offset: number) {
    for (; offset < str.length; offset++) {
        const code = str.charCodeAt(offset);
        if (code === 10 /* \n */ || code === 13 /* \r */) {
            return offset;
        }
    }

    return -1;
}

function warn(...args: unknown[]) {
    if (LOG_WARNINGS) {
        console.warn(...args.map(detachSlicedString));
    }
}

function binarySearchCodeEntryIndex(address: number, entries: BucketCodeEntry[], entryOrNext = false) {
    let lo = 0;
    let hi = entries.length - 1;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const entry = entries[mid];

        if (address < entry.start) {
            // target is entirely to the “left” of this range
            hi = mid - 1;
        } else if (address > entry.end) {
            // target is entirely to the “right” of this range
            lo = mid + 1;
        } else {
            // entry.start <= address <= entry.end
            return mid;
        }
    }

    return entryOrNext && lo < entries.length ? lo : -1;
}

const LOG_WARNINGS = false;
const CODE_EVENTS = false;
const BUCKET_SIZE = 14; // number of bits
const BUCKET_ADDRESS_BASE = 1 << BUCKET_SIZE;
const EMPTY_ARRAY = [];
export async function decode(iterator: AsyncIterableIterator<Uint8Array> | AsyncIterableIterator<string>) {
    const meta: Meta = {};
    const codes: Code[] = [];
    let lastCodeEntry: CodeEntry | null = null;
    const codeEvents: unknown[] = [];
    const codeMemoryBuckets = new Map<number, BucketCodeEntry[]>();
    const sfiByAddress = new Map<string, SFI>();
    const functions: LogFunction[] = [];
    const scriptById = new Map<number, Script>();
    let maxScriptId: number = 0;
    const ticks: Tick[] = [];
    const knownMemoryChunks = new Map<string, number>();
    const heapEvents: HeapEvent[] = [];
    const heap: Heap = { events: heapEvents };
    const ignoredOps = new Set<string>();
    const ignoredEntries: unknown[] = [];
    const unattributedICEntries: ICEntry[] = [];
    const setCodeEntry = function(codeEntry: CodeEntry) {
        let { start: address, size } = codeEntry;

        while (size > 0) {
            const codeEntryBucketAddress = address % BUCKET_ADDRESS_BASE;
            const codeEntryBucketSize = Math.min(size, BUCKET_ADDRESS_BASE - codeEntryBucketAddress);
            const bucketId = address - codeEntryBucketAddress;
            const bucketCodeEntry = new BucketCodeEntry(codeEntryBucketAddress, codeEntryBucketSize, codeEntry);

            if (codeEntryBucketSize === BUCKET_ADDRESS_BASE) {
                codeMemoryBuckets.set(bucketId, [bucketCodeEntry]);
            } else {
                let bucket = codeMemoryBuckets.get(bucketId);

                if (bucket === undefined) {
                    codeMemoryBuckets.set(bucketId, bucket = []);
                }

                setBucketCodeEntry(bucket, bucketCodeEntry);
            }

            address += codeEntryBucketSize;
            size -= codeEntryBucketSize;
        }
    };
    const setBucketCodeEntry = function(bucket: BucketCodeEntry[], bucketCodeEntry: BucketCodeEntry) {
        const { start: address } = bucketCodeEntry;

        // fast path
        if (bucket.length === 0 || address > bucket[bucket.length - 1].end) {
            bucket.push(bucketCodeEntry);
            return;
        }

        const addressEnd = address + bucketCodeEntry.size - 1;

        // fast path
        if (addressEnd < bucket[0].start) {
            bucket.unshift(bucketCodeEntry);
            return;
        }

        const firstInNewRangeEntryIndex = binarySearchCodeEntryIndex(address, bucket, true);
        const firstEntry = bucket[firstInNewRangeEntryIndex];

        if (addressEnd > firstEntry.start) {
            let lastInNewRangeEntryIndex = firstInNewRangeEntryIndex;
            for (; lastInNewRangeEntryIndex + 1 < bucket.length; lastInNewRangeEntryIndex++) {
                if (bucket[lastInNewRangeEntryIndex + 1].start > addressEnd) {
                    break;
                }
            }

            bucket.splice(firstInNewRangeEntryIndex, lastInNewRangeEntryIndex - firstInNewRangeEntryIndex + 1, bucketCodeEntry);
        } else {
            bucket.splice(firstInNewRangeEntryIndex, 0, bucketCodeEntry);
        }
    };
    const findCodeEntryByAddress = function(address: number, entryOrNext = false): CodeEntry | null {
        const codeEntryBucketAddress = address % BUCKET_ADDRESS_BASE;
        const bucketId = address - codeEntryBucketAddress;
        const bucket = codeMemoryBuckets.get(bucketId);

        if (bucket === undefined) {
            return null;
        }

        const index = binarySearchCodeEntryIndex(codeEntryBucketAddress, bucket, entryOrNext);

        return index !== -1
            ? bucket[index].codeEntry
            : null;
    };
    const addTmToEvents = (tm: number) => {
        for (let i = heapEvents.length - 1; i >= 0; i--) {
            if (heapEvents[i].tm !== 0) {
                break;
            }

            heapEvents[i].tm = tm;
        }
    };
    const processLine = (line: string) => {
        if (line.length === 0) {
            return;
        }

        const opEnd = offsetOrEnd(',', line);
        const op = line.slice(0, opEnd);
        const argsStart = opEnd + 1;

        switch (op) {
            case 'tick': {
                const [
                    pc_,
                    timestamp,
                    isExternalCallback,
                    tosOrExternalCallback_,
                    vmState,
                    ...stack
                ] = readAllArgs(parsers[op], line, argsStart);
                let pc = pc_;
                let tosOrExternalCallback = tosOrExternalCallback_;

                if (isExternalCallback) {
                    // Don't use PC when in external callback code, as it can point
                    // inside callback's code, and we will erroneously report
                    // that a callback calls itself. Instead we use tosOrExternalCallback,
                    // as simply resetting PC will produce unaccounted ticks.
                    pc = tosOrExternalCallback;
                    tosOrExternalCallback = 0;
                } else if (tosOrExternalCallback) {
                    // Find out, if top of stack was pointing inside a JS function
                    // meaning that we have encountered a frameless invocation.
                    const codeEntry = findCodeEntryByAddress(tosOrExternalCallback);

                    if (codeEntry === null || codeEntry.code.type !== 'JS') {
                        tosOrExternalCallback = 0;
                    }
                }

                const parsedStack = parseStack(pc, tosOrExternalCallback, stack, findCodeEntryByAddress);

                addTmToEvents(timestamp);
                ticks.push({
                    tm: timestamp,
                    vm: vmState,
                    s: parsedStack
                });

                break;
            }

            case 'code-creation': {
                // In some rare cases, nameAndLocation can contain a non-escaped comma,
                // which breaks normal line splitting into arguments.
                // Use custom logic for argument parsing as a workaround.
                const args = readAllArgsRaw(line, argsStart);
                const type = args[0];
                // const kindNum = args[1];
                const timestamp = parseInt(args[2]);
                const address = parseAddress(args[3]);
                const size = parseAddress(args[4]);
                let nameAndLocation = args[5];
                let sfiAddress: string | undefined = undefined;
                let kindMarker = '';

                for (let i = 6; i < args.length; i++) {
                    const arg = args[i];

                    // The next argument after nameAndLocation is an optional sfiAddress,
                    // which should be a hex-encoded address
                    if (arg.startsWith('0x')) {
                        sfiAddress = arg;
                        kindMarker = args[i + 1];
                        break;
                    }

                    nameAndLocation += ',' + parseString(args[i]);
                }

                nameAndLocation = detachSlicedString(nameAndLocation);

                const kind = kindMarker ? parseCodeState(kindMarker) : type === 'JS' ? 'Builtin' : type;
                let sfi: SFI | undefined;

                if (sfiAddress !== undefined) {
                    sfi = sfiByAddress.get(sfiAddress);

                    if (sfi === undefined || sfi.name !== nameAndLocation) {
                        const sfiCodes: number[] = [];

                        sfiByAddress.set(sfiAddress, sfi = {
                            id: functions.length,
                            name: nameAndLocation,
                            codes: sfiCodes
                        });
                        functions.push({
                            name: nameAndLocation,
                            codes: sfiCodes
                        });
                    }
                }

                let code: CodeCompiled | CodeJavaScript;

                if (sfi) {
                    sfi.codes.push(codes.length);
                    code = {
                        name: nameAndLocation,
                        type: 'JS',
                        kind,
                        size,
                        func: sfi.id,
                        tm: timestamp
                    };
                } else {
                    code = {
                        name: nameAndLocation,
                        timestamp,
                        type: 'CODE',
                        kind,
                        size
                    };
                }

                const codeEntry = new CodeEntry(codes.length, address, size, code);
                setCodeEntry(codeEntry);
                lastCodeEntry = codeEntry;
                codes.push(code);

                addTmToEvents(timestamp);

                if (CODE_EVENTS) {
                    codeEvents.push({
                        op,
                        address,
                        size,
                        type,
                        kindNum: args[1],
                        kind,
                        timestamp,
                        nameAndLocation,
                        sfiAddress
                    });
                }
                break;
            }

            case 'code-source-info': {
                const [
                    address,
                    scriptId,
                    start,
                    end,
                    positions,
                    inlinedPositions,
                    inlinedFunctions = ''
                ] = readAllArgs(parsers[op], line, argsStart);
                const codeEntry = lastCodeEntry?.start === address
                    ? lastCodeEntry
                    : findCodeEntryByAddress(address);

                if (codeEntry !== null) {
                    if (codeEntry.code.type === 'JS') {
                        codeEntry.code.source = {
                            script: scriptId,
                            start,
                            end,
                            positions,
                            inlined: inlinedPositions,
                            fns: inlinedFunctions !== ''
                                ? (inlinedFunctions.match(/[^S]+/g) || EMPTY_ARRAY)
                                    .map((sfiAddress: string) => {
                                        const sfi = sfiByAddress.get(sfiAddress);

                                        if (sfi !== undefined) {
                                            return sfi.id;
                                        }

                                        warn('No SFI found');
                                        return -1;
                                    })
                                : EMPTY_ARRAY
                        };
                    } else {
                        warn('Not a JavaScript code');
                    }
                } else {
                    warn(`Code with address ${address} is not found`);
                }

                if (CODE_EVENTS) {
                    codeEvents.push({
                        op,
                        address,
                        scriptId,
                        start,
                        end,
                        positions,
                        inlinedPositions,
                        inlinedFunctions
                    });
                }

                break;
            }

            case 'script-source': {
                const [id, url, source] = readAllArgs(parsers[op], line, argsStart);

                maxScriptId = Math.max(id, maxScriptId);
                scriptById.set(id, {
                    id,
                    url,
                    source
                });

                break;
            }

            case 'new': {
                const [type, address, size] = readAllArgs(parsers[op], line, argsStart);

                knownMemoryChunks.set(address, size);
                heapEvents.push({
                    tm: 0,
                    event: op,
                    type,
                    address,
                    size
                });

                break;
            }

            case 'delete': {
                const [type, address] = readAllArgs(parsers[op], line, argsStart);
                const chunkSize = knownMemoryChunks.get(address);

                if (chunkSize === undefined) {
                    warn(`Unknown memory chunk ${type} @ ${address}`);
                } else if (chunkSize === -1) {
                    // V8 duplicates delete events for some deletions
                    // warn(`Already deleted memory chunk ${type} @ ${address}`);
                } else {
                    knownMemoryChunks.set(address, -1);
                    heapEvents.push({
                        tm: 0,
                        event: op,
                        type,
                        address,
                        size: chunkSize
                    });
                }

                break;
            }

            case 'LoadIC':
            case 'StoreIC':
            case 'KeyedLoadIC':
            case 'KeyedStoreIC':
            case 'LoadGlobalIC':
            case 'StoreGlobalIC':
            case 'StoreInArrayLiteralIC': {
                const [
                    address,
                    tm,
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    lineNumber,
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    columnNumber,
                    oldState,
                    newState,
                    mapId,
                    key,
                    modifier,
                    slowReason
                ] = readAllArgs(parsers[op], line, argsStart);
                const pc = parseAddress(address);
                const codeEntry = lastCodeEntry?.contains(pc)
                    ? lastCodeEntry
                    : findCodeEntryByAddress(pc);
                const icEntry: ICEntry = {
                    tm,
                    type: op,
                    offset: codeEntry !== null ? pc - codeEntry.start : -1,
                    oldState: parseICState(oldState),
                    newState: parseICState(newState),
                    map: mapId,
                    key,
                    modifier,
                    slowReason
                };

                if (codeEntry !== null) {
                    if (codeEntry.code.type === 'JS') {
                        if (Array.isArray(codeEntry.code.ic)) {
                            codeEntry.code.ic.push(icEntry);
                        } else {
                            codeEntry.code.ic = [icEntry];
                        }
                    } else {
                        console.warn('Code is not JS kind', { codeEntry, icEntry });
                    }
                } else {
                    unattributedICEntries.push(icEntry);
                    console.warn(`No code ${address} found for ${op}`);
                }

                break;
            }

            //
            // rare events
            //

            case 'code-deopt': {
                const [
                    tm,
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    codeSize,     // ignore
                    address,
                    inliningId,
                    scriptOffset,
                    bailoutType,  // deopt kind
                    posText,      // deopt location
                    reason        // deopt reason
                ] = readAllArgs(parsers[op], line, argsStart);
                const codeEntry = findCodeEntryByAddress(address);

                if (codeEntry?.code.type === 'JS') {
                    // The comment from V8 tickprocessor:
                    // > Only add the deopt if there was no deopt before.
                    // > The subsequent deoptimizations should be lazy deopts for
                    // > other on-stack activations.
                    // We can collect all the deopts, however lazy deopts has no reason
                    // or any other useful details, so ignore them for now
                    if (!codeEntry.code.deopt) {
                        codeEntry.code.deopt = {
                            tm,
                            inliningId,
                            scriptOffset,
                            posText,
                            reason,
                            bailoutType
                        };
                    }
                }
                break;
            }

            case 'code-move': {
                const [address, destAddress] = readAllArgs(parsers[op], line, argsStart);
                const codeEntry = findCodeEntryByAddress(address);

                if (codeEntry !== null) {
                    // we don't care about deleting old code, since log should not address them anymore;
                    // any new code overlaping with known codes will discard old ones.
                    setCodeEntry(codeEntry.clone(destAddress));
                } else {
                    warn('No code found');
                }

                if (CODE_EVENTS) {
                    codeEvents.push({
                        op,
                        address,
                        destAddress
                    });
                }
                break;
            }

            case 'sfi-move': {
                const [address, destAddress] = readAllArgs(parsers[op], line, argsStart);
                const sfi = sfiByAddress.get(address);

                if (sfi !== undefined) {
                    sfiByAddress.delete(address);
                    sfiByAddress.set(destAddress, sfi);
                } else {
                    warn('SFI not found, on moving SFI', address, '->', destAddress);
                }

                if (CODE_EVENTS) {
                    codeEvents.push({
                        op,
                        address,
                        destAddress
                    });
                }

                break;
            }

            case 'code-delete': {
                // we don't care about deleting old code, since log should not address them anymore;
                // any new code overlaping with known codes will discard old ones.
                if (CODE_EVENTS) {
                    const [address] = readAllArgs(parsers[op], line, argsStart);
                    codeEvents.push({
                        op,
                        address
                    });
                }

                break;
            }

            case 'code-disassemble': {
                const [address, kind, disassemble] = readAllArgs(parsers[op], line, argsStart);

                if (CODE_EVENTS) {
                    codeEvents.push({
                        op,
                        address,
                        kind,
                        disassemble
                    });
                }

                break;
            }

            //
            // events that occur only in the beginning or occur just once
            //

            case 'v8-version': {
                meta.version = readAllArgsRaw(line, argsStart).join('.');
                break;
            }

            case 'v8-platform': {
                meta.platform = readAllArgsRaw(line, argsStart).join('/');
                break;
            }

            case 'profiler': {
                const [action, samplesInterval] = readAllArgs(parsers[op], line, argsStart);

                if (action === 'start') {
                    meta.samplesInterval = samplesInterval;
                }
                break;
            }

            case 'heap-capacity': {
                const [capacity] = readAllArgs(parsers[op], line, argsStart);

                heap.capacity = capacity;
                break;
            }

            case 'heap-available': {
                const [available] = readAllArgs(parsers[op], line, argsStart);

                heap.available = available;
                break;
            }

            case 'shared-library': {
                const [name, address, addressEnd, aslrSlide] = readAllArgs(parsers[op], line, argsStart);
                const code: CodeSharedLib = {
                    name,
                    type: 'SHARED_LIB'
                };

                setCodeEntry(new CodeEntry(codes.length, address, addressEnd - address, code));
                codes.push(code);

                // if (globalThis.__cpps) {
                //     const a = globalThis.__cpps[name];
                //     if (Array.isArray(a)) {
                //         codes.push(...a);
                //     }
                // }

                if (CODE_EVENTS) {
                    codeEvents.push({
                        op,
                        address,
                        size: addressEnd - address,
                        name,
                        aslrSlide
                    });
                }

                break;
            }

            case 'shared-library-end': {
                // do nothing
                break;
            }

            default:
                ignoredOps.add(op);
                ignoredEntries.push({ op, line });
        }

    };

    let tail = '';
    let lineStartOffset = 0;
    let lineEndOffset = -1;
    // In fact, V8 always writes the V8 log with `\n` newlines, even on Windows.
    // This logic to handle `\r\n` (and `\r`) newlines is implemented as an extra safeguard
    // to ensure everything works. Falling back to slow newline search makes parsing
    // about 1.5x slower. However, this might never actually occur. Detection for `\r`-like newlines
    // is implemented at a very low-impact level. So let’s give it a try. It probably should be
    // removed in the future as redundant. Let’s see.
    let slowNewlineSearch = false;
    let maybeCR = true;

    for await (const chunk of iterator) {
        const chunkText = typeof chunk === 'string'
            ? chunk
            : decoder.decode(chunk, { stream: true });

        lineStartOffset = 0;

        if (maybeCR && !slowNewlineSearch) {
            slowNewlineSearch = typeof chunk === 'string'
                ? chunk.includes('\r')
                : chunk.includes(13);
        }

        do {
            lineEndOffset = slowNewlineSearch
                ? findNewline(chunkText, lineStartOffset)
                : chunkText.indexOf('\n', lineStartOffset);

            if (lineEndOffset === -1) {
                break;
            }

            if (tail !== '') {
                processLine(tail + chunkText.slice(lineStartOffset, lineEndOffset));
                tail = '';
            } else if (lineStartOffset < lineEndOffset) {
                processLine(chunkText.slice(lineStartOffset, lineEndOffset));
            }

            lineStartOffset = lineEndOffset + 1;
            maybeCR = false;
        } while (true);

        tail += chunkText.slice(lineStartOffset);
    }

    // process last line
    if (tail !== '') {
        processLine(tail);
        tail = '';
    }

    const result: ParseResult = {
        meta,
        code: codes,
        functions,
        ticks,
        scripts: Array.from({ length: maxScriptId + 1 }, (_, idx) => scriptById.get(idx) || null),
        unattributedICEntries,
        heap,

        // codeEvents,
        ignoredOps: [...ignoredOps],
        ignoredEntries
    };

    return result;
}
