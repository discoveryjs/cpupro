import { CodeState } from './types.js';

const useBigInt = false as const;
export const parseAddress = // useBigInt ? BigInt :
    parseInt;

export function parseState(state: string) {
    switch (state) {
        case '':  return CodeState.COMPILED;
        case '~': return CodeState.IGNITION;
        case '^': return CodeState.SPARKPLUG;
        case '+': return CodeState.MAGLEV;
        case '*': return CodeState.TURBOFAN;
    }

    throw new Error(`Unknown code state: ${state}`);
}

export function kindFromState(state: CodeState) {
    switch (state) {
        case CodeState.COMPILED: return 'Buildin';
        case CodeState.IGNITION: return 'Unopt';
        case CodeState.SPARKPLUG: return 'Sparkplug';
        case CodeState.MAGLEV: return 'Maglev';
        case CodeState.TURBOFAN: return 'Opt';
    }

    throw new Error(`Unknown code state: ${state}`);
}

export function parseString(value: string) {
    if (value.indexOf('\\') === -1) {
        return value;
    }

    const valueEnd = value.length;
    let result = '';

    for (let i = 0; i < valueEnd; i++) {
        if (value[i] !== '\\') {
            result += value[i];
            continue;
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

    return result;
}

export function parseStack(pc: number, logStack: string[]) {
    const parsedStack: number[] = [];

    for (let i = 0; i < logStack.length; i++) {
        const frame = logStack[i];
        const firstChar = frame[0];
        if (firstChar === '+' || firstChar === '-') {
            // An offset from the previous frame.
            debugger;
            parsedStack.push(pc += parseInt(frame));
        // Filter out possible 'overflow' string.
        } else if (firstChar !== 'o') {
            parsedStack.push(parseInt(frame));
        } else {
            console.error(`Dropping unknown tick frame: ${frame}`);
        }
    }

    return parsedStack;
}
