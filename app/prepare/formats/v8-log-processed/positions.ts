import type { V8LogCode } from './types.js';

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
    let high = (parsedPositions.length / 3) | 0;
    let ans = -1;

    while (low <= high) {
        const mid = (low + high) >> 1;
        const idx = mid * 3;
        const midValue = parsedPositions[idx];

        if (midValue === target) {
            return idx;
        }

        if (midValue < target) {
            ans = idx;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    return ans !== -1 ? ans : 0;
}

export function processCodePositions(codes: V8LogCode[]) {
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

        if (inlined !== null) {
            for (let i = 0; i < inlined.length; i += 3) {
                inlined[i] = source.fns[inlined[i]];
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
