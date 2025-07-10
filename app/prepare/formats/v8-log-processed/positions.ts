import { functionTier } from './codes.js';
import type { CodePositionTable, NumericArray, V8LogCode } from './types.js';

// Parse "positions" and "inlined" of code.source:
// - "positions" is a sequence of entries with pattern /C\d+O\d+(I\d+)?/, e.g. "C0O1C20O30I0..."
// - "inlined" is a sequence of entries with pattern /F\d+O\d+(I\d+)?/, e.g. "F0O10F1O20I0..."
export function parsePositions(positions: string) {
    const result: number[] = [];
    let inline = false;
    let n = 0;

    for (let i = 1; i < positions.length; i++) {
        const code = positions.charCodeAt(i);

        switch (code) {
            case 67: // C
            case 70: // F
                if (inline) {
                    result.push(n);
                } else {
                    result.push(n, -1);
                }
                inline = false;
                n = 0;
                break;

            case 79: // O
                result.push(n);
                n = 0;
                break;

            case 73: // I
                result.push(n);
                inline = true;
                n = 0;
                break;

            default: // 0..9
                n = n * 10 + (code - 48);
        }
    }

    if (inline) {
        result.push(n);
    } else {
        result.push(n, -1);
    }

    return result;
}

export function findPositionsCodeIndex(parsedPositions: number[], target: number) {
    let low = 0;
    let high = ((parsedPositions.length / 3) | 0) - 1;

    while (low <= high) {
        const mid = (low + high) >> 1;
        const idx = mid * 3;
        const midValue = parsedPositions[idx];

        if (midValue === target) {
            return idx;
        }

        if (midValue < target) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    return high === -1 ? 0 : high * 3;
}

export function processCodePositionTables(
    v8logCodes: V8LogCode[],
    functionIdMap: NumericArray | null = null
): (CodePositionTable | null)[] {
    return v8logCodes.map(code => {
        const funcIdx = code.func;
        const source = code.source;

        if (funcIdx === undefined || source === undefined) {
            return null;
        }

        const sourcePositions = source.positions;

        if (!sourcePositions) {
            return null;
        }

        // Machine code functions on the stack
        // that are not currently executing store pc
        // on the next instruction after the callee is called,
        // so subtract one from the position is needed.
        // That's not the case for Ignition bytecode.
        const pcOnNextInstruction = functionTier(code.kind) !== 'Ignition';
        const positions = parsePositions(sourcePositions);
        const lastCode = positions[positions.length - 3];
        const inlined = source.inlined
            ? parsePositions(source.inlined)
            : null;
        const fns = inlined !== null && Array.isArray(source.fns) && source.fns.length > 0
            ? source.fns.slice()
            : [];

        if (inlined !== null) {
            // Validate and remap function ID list
            for (let i = 0; i < fns.length; i++) {
                const functionId = fns[i];

                // FIXME: In some rare cases, the fns array contains null (or -1 for our custom V8 log decoder)
                // instead of function id. For now, we ignore the function positions as it not defined.
                // We could try finding similar positions in other codes of the function and use those if available.
                // However, this does not always resolve the issue, so for now we output warnings and ignore
                // positions for such codes to collect more cases.
                if (functionId === null || functionId < 0) {
                    console.error('Broken positions', code, { positions, inlined, fns: source.fns });
                    return null;
                }

                // Remap function ID, if map provided
                if (functionIdMap !== null) {
                    fns[i] = functionIdMap[functionId];
                }
            }

            // Substitute function ID in place of index reference to avoid the need for a lookup
            // in the fns array when using inlined array.
            for (let i = 0; i < inlined.length; i += 3) {
                const functionId = fns[inlined[i]] ?? null;

                if (functionId === null || functionId < 0) {
                    console.error('Broken positions', code, { positions, inlined });
                    return null;
                }

                inlined[i] = functionId;
            }
        }

        return {
            fistCode: positions[0],
            lastCode,
            pcOnNextInstruction,
            positions,
            inlined,
            fns
        };
    });
}
