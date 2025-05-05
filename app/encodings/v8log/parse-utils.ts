import { CodeState } from './types.js';

// const useBigInt = false as const;
export const parseAddress = parseInt; // useBigInt ? BigInt : parseInt;

export function parseState(state: string) {
    switch (state) {
        case '':
            return CodeState.COMPILED;
        case '~':
            return CodeState.IGNITION;
        case '^':
            return CodeState.SPARKPLUG;
        case '+':
        case '+\'': // context specialized
            return CodeState.MAGLEV;
        case '*':
        case '*\'': // context specialized
            return CodeState.TURBOFAN;
    }

    throw new Error(`Unknown code state: ${state}`);
}

export function kindFromState(state: CodeState) {
    switch (state) {
        case CodeState.COMPILED: return 'Builtin';
        case CodeState.IGNITION: return 'Unopt';
        case CodeState.SPARKPLUG: return 'Sparkplug';
        case CodeState.MAGLEV: return 'Maglev';
        case CodeState.TURBOFAN: return 'Opt';
    }

    throw new Error(`Unknown code state: ${state}`);
}

// Make a copy of the sliced string to detach from input (parent) string
export function detachSlicedString(value: string) {
    if (value === '') {
        return '';
    }

    // That's a hack to detach (make a copy of) the sliced string from its parent (source),
    // so the parent can be GCed.
    // To make a search across object's keys, the string must be internalizated (at least in V8).
    // Using `in` operator enforces JS engine to make a copy of the string and compute its hash.
    // Having a hash makes the string fast for further using as a key. Probably, that's not necessary
    // for most of the strings and another approach should be choosen (like using replace() commented
    // below). However, basic benchmarking doesn't demonstrated any difference in results,
    // but with `in` operator approach shows ~10% lower memory footprint after GC on large log loading.
    // Since the object is not escape the function, optimized code should avoid an allocation
    // on each invocation and re-use the object (need to be comfirmed).
    value in {};

    return value;
    // return value.replace(value[0], value[0]);
}

export function parseString(value: string) {
    if (value === '' || value.indexOf('\\') === -1) {
        return detachSlicedString(value);
    }

    const valueEnd = value.length;
    let result = '';

    for (let i = 0; i < valueEnd; i++) {
        const bidx = value.indexOf('\\', i);

        if (bidx === -1) {
            result += value.slice(i);
            break;
        }

        if (bidx !== i) {
            result += value.slice(i, bidx);
            i = bidx;
        }

        if (i === valueEnd - 1) {
            console.error('Invalid backslash', { inside: [i, i + 1] });
            break;
        }

        const next = value[++i];
        switch (next) {
            case '0': result += '\0'; break;
            case 'b': result += '\b'; break;
            case 'n': result += '\n'; break;
            case 'r': result += '\r'; break;
            case 'f': result += '\f'; break;
            case 't': result += '\t'; break;
            case 'v': result += '\v'; break;

            case 'u': {
                const [hex = ''] = value.slice(i + 1, i + 5).match(/^[0-9a-f]*/i) || [];

                if (hex.length === 4) {
                    result += String.fromCharCode(parseInt(hex, 16));
                    i += 4;
                    break;
                }

                console.error('Invalid Unicode escape sequence', {
                    inside: [i - 1, Math.min(i + 1 + hex.length, valueEnd)]
                });
                break;
            }

            case 'x': {
                const [hex = ''] = value.slice(i + 1, i + 3).match(/^[0-9a-f]*/i) || [];

                if (hex.length === 2) {
                    result += String.fromCharCode(parseInt(hex, 16));
                    i += 2;
                    break;
                }

                console.error('Invalid hexadecimal escape sequence', {
                    inside: [i - 1, Math.min(i + 1 + hex.length, valueEnd)]
                });
                break;
            }

            default:
                result += next;
        }
    }

    // This is a hack to flatten the concatenated string and detach its parts from the source strings,
    // allowing them to be garbage collected.
    // The JS engine requires a string to be represented as a single sequence of bytes (flattened)
    // to perform complex operations like `regexp.test()`. The regex effectively does nothing,
    // but compilers are unaware of this and cannot eliminate the `test()` call, which triggers flattening.
    /^/.test(result);

    return result;
}

export function parseStack(
    pc: number,
    func: number,
    logStack: string[],
    findCodeEntryByAddress: (address: number) => { id: number; start: number; } | null
) {
    const parsedStack: number[] = new Array(2 * (logStack.length + (func ? 2 : 1)));
    let parsedStackCursor = 0;
    const pushStackEntry = (address: number) => {
        const codeEntry = findCodeEntryByAddress(address);

        if (codeEntry !== null) {
            parsedStack[parsedStackCursor++] = codeEntry.id;
            parsedStack[parsedStackCursor++] = address - codeEntry.start;
        } else {
            parsedStack[parsedStackCursor++] = -1;
            parsedStack[parsedStackCursor++] = address;
        }
    };

    pushStackEntry(pc);

    if (func) {
        pushStackEntry(func);
    }

    for (let i = 0; i < logStack.length; i++) {
        const frame = logStack[i];

        switch (frame.charCodeAt(0)) {
            case 43: // +
            case 45: // -
                pushStackEntry(pc += parseInt(frame));
                break;

            case 111: // o
                // overflow frame – just ignore
                // console.warn(`Dropping unknown tick frame: ${frame}`);
                break;

            default:
                pushStackEntry(parseInt(frame));
        }
    }

    if (parsedStackCursor < parsedStack.length) {
        parsedStack.length = parsedStackCursor;
    }

    return parsedStack;
}
