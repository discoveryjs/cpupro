import type { CodePositions, V8LogCode, V8LogFunction } from './types.js';

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

export function processCodePositions(codes: V8LogCode[]): (CodePositions | null)[] {
    return codes.map(code => {
        const funcIdx = code.func;
        const source = code.source;

        if (funcIdx === undefined || source === undefined) {
            return null;
        }

        const sourcePositions = source.positions;

        if (!sourcePositions) {
            return null;
        }

        const positions = parsePositions(sourcePositions);
        const lastCode = positions[positions.length - 3];
        const inlined = source.inlined
            ? parsePositions(source.inlined)
            : null;

        // if (code.name.startsWith('visitNodes ')) {
        //     console.log(code);
        //     positions.x = 1;
        // }

        if (inlined !== null) {
            for (let i = 0; i < inlined.length; i += 3) {
                // FIXME: In some rare cases, the fns array contains null instead of function id.
                // For now, we ignore the function positions as it not defined. However, we can try to find
                // similar positions in other codes of the function and use it if any.
                const functionId = source.fns[inlined[i]];

                if (functionId === null) {
                    console.error('Broken positions', code, { positions, inlined });
                    return null;
                }

                inlined[i] = functionId;
            }
        }

        return {
            fistCode: positions[0],
            lastCode,
            positions,
            inlined
        };
    });
}

export function processCallFramePositions(
    codes: V8LogCode[],
    functions: V8LogFunction[],
    callFrameIndexByCode: Uint32Array
) {
    const positionsByCode = processCodePositions(codes);

    // replace function index in inline info for a call frame index (first code in function's codes)
    for (const positions of positionsByCode) {
        if (positions === null || !positions.inlined) {
            continue;
        }

        for (let i = 0; i < positions.inlined.length; i += 3) {
            const callFrameIndex = callFrameIndexByCode[functions[positions.inlined[i]].codes[0]];

            if (typeof callFrameIndex !== 'number') {
                throw new Error('Can\'t resolve call frame for an inlined function');
            }

            positions.inlined[i] = callFrameIndex;
        }
    }

    return positionsByCode;
}
