import { argParsers, offsetOrEnd, readAllArgs, readAllArgsRaw } from './read-args-utils.js';
import { detachSlicedString, parseAddress, parseCodeState, parseString, parseICState, isSpecialized } from './parse-utils.js';
import { Code, CodeCompiled, CodeJavaScript, CodeSharedLib, Heap, HeapEvent, ICEntry, LogFunction, Meta, ParseResult, Script, SFI, Tick } from './types.js';
import { CodeMap, CodeEntry } from './code-map.js';

const LOG_WARNINGS = false;
const CODE_EVENTS = false;
const EMPTY_ARRAY = [];
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

function warn(...args: unknown[]) {
    if (LOG_WARNINGS) {
        console.warn(...args.map(detachSlicedString));
    }
}

export async function processV8logEvents(lineIterator: AsyncIterableIterator<string>) {
    const meta: Meta = {};
    const codes: Code[] = [];
    const codeEvents: unknown[] = [];
    const codeMap = new CodeMap();
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
                    const codeEntry = codeMap.findByAddress(tosOrExternalCallback);

                    if (codeEntry === null || codeEntry.code.type !== 'JS') {
                        tosOrExternalCallback = 0;
                    }
                }

                const parsedStack = codeMap.resolveStack(pc, tosOrExternalCallback, stack);

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
                let nameAndLocation = parseString(args[5]);
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
                const specialized = isSpecialized(kindMarker);
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
                        specialized,
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
                        specialized,
                        size
                    };
                }

                const codeEntry = new CodeEntry(codes.length, address, size, code);
                codeMap.add(codeEntry);
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
                const codeEntry = codeMap.findByAddress(address);

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

                                        warn('(code-source-info) No SFI found');
                                        return -1;
                                    })
                                : EMPTY_ARRAY
                        };
                    } else {
                        warn('(code-source-info) Not a JavaScript code');
                    }
                } else {
                    warn(`(code-source-info) Code with address ${address} is not found`);
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
                    warn(`(delete) Unknown memory chunk ${type} @ ${address}`);
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
                const codeEntry = codeMap.findByAddress(pc);
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
                        warn(`(${op}) Code is not JS kind`, { codeEntry, icEntry });
                    }
                } else {
                    unattributedICEntries.push(icEntry);
                    warn(`(${op}) No code ${address} found for ${op}`);
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
                const codeEntry = codeMap.findByAddress(address);

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
                const codeEntry = codeMap.findByAddress(address);

                if (codeEntry !== null) {
                    // we don't care about deleting old code, since log should not address them anymore;
                    // any new code overlaping with known codes will discard old ones.
                    codeMap.add(codeEntry.clone(destAddress));
                } else {
                    warn('(code-move) No code found');
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
                    warn('(sfi-move) SFI not found, on moving SFI', address, '->', destAddress);
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
                const code = codeMap.findByAddress(address)?.code || null;

                if (code !== null) {
                    if (code.type === 'JS' || code.type === 'CODE') {
                        code.disassemble = disassemble;
                    } else {
                        warn('(code-disassemble) Code is not JS or CODE type');
                    }
                } else {
                    warn('(code-disassemble) No code found');
                }

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

                codeMap.add(new CodeEntry(codes.length, address, addressEnd - address, code));
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

    for await (const line of lineIterator) {
        processLine(line);
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

    // console.log(result);
    // console.log({ icOk, unattributedICEntries })
    // console.log(ignoredEntries.reduce((map, entry) => {
    //     const x = map.get(entry.op);
    //     if (x === undefined) {
    //         map.set(entry.op, [entry.line])
    //     } else {
    //         x.push(entry.line);
    //     }
    //     return map;
    // }, new Map()));

    return result;
}

export async function processV8logRaw(lineIterator: AsyncIterableIterator<string>) {
    type Entry = { op: string; args: (number | string)[]; };
    const entries: Entry[] = [];

    for await (const line of lineIterator) {
        if (line.length !== 0) {
            const opEnd = offsetOrEnd(',', line);
            const op = line.slice(0, opEnd);
            const argsStart = opEnd + 1;
            const args = Object.hasOwn(parsers, op)
                ? readAllArgs(parsers[op], line, argsStart)
                : readAllArgsRaw(line, argsStart);

            entries.push({ op, args });
        }
    }

    return entries;
}
