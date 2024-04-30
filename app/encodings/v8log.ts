import { argParsers, offsetOrEnd, readAllArgs, readAllArgsRaw } from './v8log/read-args-utils.js';
import { kindFromState, parseAddress, parseStack, parseState, parseString } from './v8log/parse-utils.js';
import { CodeState, Meta } from './v8log/types.js';

const decoder = new TextDecoder();

const parsers = {
    'profiler': argParsers(parseString, parseInt),
    'heap-capacity': argParsers(parseInt),
    'heap-available': argParsers(parseInt),
    'new': argParsers(parseString, parseAddress, parseInt),
    'delete': argParsers(parseString, parseAddress),
    'script-source': argParsers(parseInt, parseString, parseString),
    'shared-library': argParsers(parseString, parseAddress, parseAddress, parseAddress),
    'code-creation': argParsers(parseString, parseInt, parseInt, parseAddress, parseAddress, parseString),
    'code-move': argParsers(parseAddress, parseAddress),
    'sfi-move': argParsers(parseAddress, parseAddress),
    'code-delete': argParsers(parseAddress),
    'code-source-info': argParsers(parseAddress, parseInt, parseInt, parseInt, parseString, parseString, parseString),
    'code-disassemble': argParsers(parseAddress, parseString, parseString),
    'tick': argParsers(parseAddress, parseInt, parseInt, parseAddress, parseInt)
} as const;

export async function decode(iterator) {
    const meta: Meta = {};
    const codes: unknown[] = [];
    const sources: unknown[] = [];
    const ticks: unknown[] = [];
    const memory: unknown[] = [];
    const profiler: unknown[] = [];
    const ignoredOps = new Set();
    const ignoredEntries: unknown[] = [];
    const processLine = (buffer: string, sol: number, eol: number) => {
        if (sol >= eol) {
            return;
        }

        const line = buffer.slice(sol, eol);
        const opEnd = offsetOrEnd(',', line);
        const argsStart = opEnd + 1;
        const op = buffer.slice(sol, sol + opEnd);

        switch (op) {
            case 'v8-version': {
                meta.version = readAllArgsRaw(line, argsStart).join('.');
                break;
            }

            case 'v8-platform': {
                meta.platform = readAllArgsRaw(line, argsStart).join('/');
                break;
            }

            case 'profiler': {
                const [action, sampleInterval] = readAllArgs(parsers[op], line, argsStart);

                profiler.push({
                    action,
                    sampleInterval
                });
                break;
            }

            case 'heap-capacity': {
                const [heapCapacity] = readAllArgs(parsers[op], line, argsStart);
                meta.heapCapacity = heapCapacity;
                break;
            }

            case 'heap-available': {
                const [heapAvailable] = readAllArgs(parsers[op], line, argsStart);
                meta.heapAvailable = heapAvailable;
                break;
            }

            case 'new': {
                const [type, address, size] = readAllArgs(parsers[op], line, argsStart);

                memory.push({
                    op,
                    type,
                    address,
                    size
                });

                break;
            }

            case 'delete': {
                const [type, address, size] = readAllArgs(parsers[op], line, argsStart);

                memory.push({
                    op,
                    type,
                    address,
                    size
                });

                break;
            }

            case 'script-source': {
                const [scriptId, url, source] = readAllArgs(parsers[op], line, argsStart);

                sources.push({
                    scriptId,
                    url,
                    source
                });

                break;
            }

            case 'shared-library': {
                const [name, address, addressEnd, aslrSlide] = readAllArgs(parsers[op], line, argsStart);

                codes.push({
                    op,
                    address,
                    size: addressEnd - address,
                    name,
                    aslrSlide
                });

                break;
            }

            case 'code-move':
            case 'sfi-move': {
                const [address, destAddress] = readAllArgs(parsers[op], line, argsStart);

                codes.push({
                    op,
                    address,
                    destAddress
                });

                break;
            }

            case 'code-delete': {
                const [address] = readAllArgs(parsers[op], line, argsStart);

                codes.push({
                    op,
                    address
                });

                break;
            }

            case 'code-disassemble': {
                const [address, kind, disassemble] = readAllArgs(parsers[op], line, argsStart);

                codes.push({
                    op,
                    address,
                    kind,
                    disassemble
                });

                break;
            }

            case 'code-source-info': {
                const [
                    address,
                    scriptId,
                    start,
                    end,
                    sourcePositions,
                    inliningPositions,
                    inlinedFunctions
                ] = readAllArgs(parsers[op], line, argsStart);

                codes.push({
                    op,
                    address,
                    scriptId,
                    start,
                    end,
                    sourcePositions,
                    inliningPositions,
                    inlinedFunctions
                });

                break;
            }

            case 'code-creation': {
                const [
                    type,
                    kind,
                    timestamp,
                    address,
                    size,
                    nameAndPosition,
                    maybeFunc
                ] = readAllArgs(parsers['code-creation'], line, argsStart);
                let stateName = '';
                let funcAddr: number | null = null;
                let funcState: CodeState | null = null;

                if (maybeFunc?.length) {
                    stateName = maybeFunc[1] ?? '';

                    funcAddr = parseAddress(maybeFunc[0]);
                    funcState = parseState(stateName);
                    // let sfi = codeMap.findDynamicEntryByStartAddress(funcAddr);

                    // if (sfi === null) {
                    //     sfi = new SharedFunctionInfoEntry(nameAndPosition);
                    //     codeMap.addCode(funcAddr, sfi);
                    // } else {
                    //     // SFI object has been overwritten with a new one.
                    //     sfi.name = nameAndPosition; // ??
                    // }

                    // let entry = codeMap.findDynamicEntryByStartAddress(address);
                    // if (entry !== null) {
                    //     if (entry.size === size && entry.sfi === sfi) {
                    //         // Entry state has changed.
                    //         entry.state = state;
                    //     } else {
                    //         codeMap.deleteCode(address);
                    //         entry = null;
                    //     }
                    // }

                    // if (entry === null) {
                    //     entry = new DynamicFuncCodeEntry(size, type, sfi, state);
                    //     codeMap.addCode(address, entry);
                    // }
                }

                codes.push({
                    op,
                    address,
                    size,
                    type,
                    kind,
                    kindName: kindFromState(funcState ?? parseState(stateName)),
                    timestamp,
                    nameAndPosition,
                    funcAddr,
                    funcState
                });
                break;
            }

            case 'tick': {
                const [
                    pc_,
                    timestamp,
                    externalCallback,
                    tosOrExternalCallback_,
                    vmState,
                    stack
                ] = readAllArgs(parsers[op], line, argsStart);
                let pc = pc_;
                let tosOrExternalCallback = tosOrExternalCallback_;

                if (externalCallback) {
                    // Don't use PC when in external callback code, as it can point
                    // inside callback's code, and we will erroneously report
                    // that a callback calls itself. Instead we use tosOrExternalCallback,
                    // as simply resetting PC will produce unaccounted ticks.
                    pc = tosOrExternalCallback;
                    tosOrExternalCallback = 0;
                // } else if (tosOrExternalCallback) {
                //     // Find out, if top of stack was pointing inside a JS function
                //     // meaning that we have encountered a frameless invocation.
                //     const funcEntry = this.profile_.findEntry(tosOrExternalCallback);
                //     if (!funcEntry || !funcEntry.isJSFunction || !funcEntry.isJSFunction()) {
                //         tosOrExternalCallback = 0;
                //     }
                }

                ticks.push({
                    timestamp,
                    vmState,
                    pc,
                    tosOrExternalCallback,
                    stack: stack ? parseStack(pc, stack) : []
                });

                break;
            }

            default:
                ignoredOps.add(op);
                ignoredEntries.push({ op, line });
        }

    };

    let tail = '';
    let lineStartOffset = 0;

    const t = Date.now();
    for await (const chunk of iterator) {
        const chunkText = tail + decoder.decode(chunk);
        let eol = -1;

        lineStartOffset = 0;

        do {
            eol = chunkText.indexOf('\n', lineStartOffset + 1);

            if (eol === -1) {
                break;
            }

            if (eol === lineStartOffset + 1) {
                continue;
            }

            processLine(chunkText, lineStartOffset, eol);
            lineStartOffset = eol + 1;
        } while (true);

        tail = String(chunkText.slice(lineStartOffset));
    }
    console.log('parsed', Date.now() - t);

    // process last line
    processLine(tail, lineStartOffset, tail.length);

    const result = {
        meta,
        codes,
        ticks,
        sources,
        ignoredOps: [...ignoredOps],
        ignoredEntries
    };

    console.log(result);

    return result;
}
