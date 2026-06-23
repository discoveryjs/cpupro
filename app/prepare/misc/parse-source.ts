import { parse } from '@babel/parser';
import { CpuProScript } from '../types';
import { createLineBoundaries } from './line-boundaries';

type FunctionRanges = {
    ranges: FunctionRange[];
    starts: number[];
    indexes: number[];
};
type FunctionRange = {
    type: string;
    name: string;
    callFrameStart: number;
    callFrameStartLine: number;
    callFrameStartColumn: number;
    start: number;
    end: number;
    loc: {
        start: { line: number; column: number; };
        end: { line: number; column: number; };
    };
}

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
        // console.log('parse source for function ranges', script.url);
        functionRanges = getFunctionRanges(script.source, script.url);
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

    if (functionRanges.starts) {
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
        const startsBefore = range.loc.start.line < line || (range.loc.start.line === line && range.loc.start.column <= column);
        const endsAfter = range.loc.end.line > line || (range.loc.end.line === line && range.loc.end.column >= column);

        if (startsBefore && endsAfter) {
            if (candidate === null || range.end - range.start < candidate.end - candidate.start) {
                candidate = range;
            }
        } else if (candidate !== null) {
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

export function getFunctionRanges(code: string, url?: string | null): FunctionRanges {
    let ast: ASTNode | null = null;
    const functionRanges: FunctionRanges = {
        ranges: [],
        starts: [],
        indexes: []
    };

    try {
        ast = parse(code, {
            sourceType: 'unambiguous',
            plugins: ['typescript', 'jsx', 'decorators']
            // ranges: true,
            // errorRecovery: true
        }) as ASTNode;
    } catch (e) {
        console.error(`Failed to parse ${url ? `"${url}"` : 'source'} for function ranges:`);
        return functionRanges;
    }

    function isFunctionNode(n: ASTNode | null): n is ASTNode {
        if (!n || typeof n.type !== 'string') {
            return false;
        }

        return (
            n.type === 'FunctionDeclaration' ||
            n.type === 'FunctionExpression' ||
            n.type === 'ArrowFunctionExpression' ||
            n.type === 'ClassDeclaration' ||
            n.type === 'ClassExpression' ||
            n.type === 'ClassMethod' ||
            n.type === 'ClassPrivateMethod' ||
            n.type === 'ObjectMethod' ||
            n.type === 'TSDeclareFunction'
        );
    }

    function findCallFrameStart(node: ASTNode) {
        if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
            return code.indexOf('(', node.start);
        }
        if (node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod' || node.type === 'ObjectMethod') {
            return code.indexOf('(', node.key.end);
        }
    }

    function getFunctionName(node: ASTNode, parent: ASTNode | null): string {
        if (node.id && typeof node.id.name === 'string') {
            return node.id.name;
        }

        if (node.key) {
            if (typeof node.key.name === 'string') {
                return node.key.name;
            }

            if (typeof node.key.value === 'string') {
                return node.key.value;
            }
        }

        if (parent) {
            if (parent.id && typeof parent.id.name === 'string') {
                return parent.id.name;
            }

            if (parent.key) {
                if (typeof parent.key.name === 'string') {
                    return parent.key.name;
                }

                if (typeof parent.key.value === 'string') {
                    return parent.key.value;
                }
            }

            if (parent.left && typeof parent.left.name === 'string') {
                return parent.left.name;
            }
        }

        return '';
    }

    type ASTNode = {
        type: string;
        start: number;
        end: number;
        loc: {
            start: { line: number; column: number; };
            end: { line: number; column: number; };
        };
    } & {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [key: string]: any;
    };
    function walk(node: ASTNode, parent: ASTNode | null = null) {
        if (!node || typeof node !== 'object') {
            return;
        }

        if (isFunctionNode(node)) {
            const nodeStart = node.start || 0;
            const callFrameStart = findCallFrameStart(node) || nodeStart;
            let callFrameStartLine = node.loc.start.line;
            let callFrameStartColumn = node.loc.start.column;

            if (callFrameStart > nodeStart) {
                let lineDiff = 0;
                let columnDiff = 0;

                for (let i = callFrameStart; i > nodeStart; i--) {
                    const char = code.charCodeAt(i);
                    if (char === 10) { // '\n'
                        lineDiff++;
                    } else if (char === 13) { // '\r'
                        lineDiff++;
                        if (i > 0 && code.charCodeAt(i - 1) === 10) { // '\r\n'
                            i--;
                        }
                    } else if (lineDiff === 0) {
                        columnDiff++;
                    }
                }

                callFrameStartLine -= lineDiff;
                callFrameStartColumn = lineDiff === 0
                    ? callFrameStartColumn + columnDiff
                    : columnDiff;
            }

            functionRanges.ranges.push({
                type: node.type,
                name: getFunctionName(node, parent),
                start: node.start,
                callFrameStart,
                callFrameStartLine,
                callFrameStartColumn,
                // slice: code.slice(node.start, node.end),
                end: node.end,
                loc: node.loc
            });
        }

        // simple recursive walk
        for (const key of Object.keys(node)) {
            const v = node[key];
            if (!v) {
                continue;
            }

            if (Array.isArray(v)) {
                for (let i = 0; i < v.length; i++) {
                    walk(v[i], node);
                }
            } else if (typeof v.type === 'string') {
                walk(v, node);
            }
        }
    }

    walk(ast);
    functionRanges.ranges.sort((a, b) => a.start - b.start || b.end - a.end);

    if (functionRanges.ranges.length > 0) {
        // build index for faster search
        Object.assign(functionRanges, buildFunctionRangesIndex(functionRanges));
    }

    return functionRanges;
}

function buildFunctionRangesIndex({ ranges }: FunctionRanges) {
    const rangeStarts: number[] = ranges[0].start !== 0 ? [0] : [];
    const rangeIndecies: number[] = ranges[0].start !== 0 ? [-1] : [];
    const stack: number[] = [-1];
    let lastPos = 0;

    for (let i = 0; i < ranges.length; i++) {
        const range = ranges[i];

        while (stack.length > 1) {
            const top = stack[stack.length - 1];
            const end = ranges[top].end;

            if (end > range.start) {
                break;
            }

            stack.pop();

            if (lastPos < end) {
                lastPos = end;
                rangeStarts.push(end);
                rangeIndecies.push(stack[stack.length - 1]);
            } else {
                rangeIndecies[rangeIndecies.length - 1] = stack[stack.length - 1];
            }
        }

        if (lastPos < range.start) {
            lastPos = range.start;
            rangeStarts.push(range.start);
            rangeIndecies.push(i);
        } else {
            rangeIndecies[rangeIndecies.length - 1] = i;
        }

        stack.push(i);
    }

    while (stack.length > 1) {
        const top = stack[stack.length - 1];
        const end = ranges[top].end;

        stack.pop();

        if (lastPos < end) {
            lastPos = end;
            rangeStarts.push(end);
            rangeIndecies.push(stack[stack.length - 1]);
        } else {
            rangeIndecies[rangeIndecies.length - 1] = stack[stack.length - 1];
        }
    }

    return {
        starts: new Uint32Array(rangeStarts),
        indexes: new Int32Array(rangeIndecies)
    };
}
