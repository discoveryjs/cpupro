import { parse } from '@babel/parser';
import { CpuProScript } from '../types';
import { createLineBoundaries } from './line-boundaries';

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
const scriptFunctionRanges = new WeakMap<CpuProScript, FunctionRange[]>();

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

export function findFunctionAtPosition(functionRanges: FunctionRange[], position: number) {
    let candidate: FunctionRange | null = null;
    let candidateLength = Infinity;

    for (const range of functionRanges) {
        if (range.start <= position && position <= range.end) {
            const rangeLength = range.end - range.start;

            if (rangeLength < candidateLength) {
                candidate = range;
                candidateLength = rangeLength;
            }
        }
    }

    return candidate;
}

export function findFunctionAtLineColumn(functionRanges: FunctionRange[], line: number, column: number) {
    let candidate: FunctionRange | null = null;

    for (const range of functionRanges) {
        const startsBefore = range.loc.start.line < line || (range.loc.start.line === line && range.loc.start.column <= column);
        const endsAfter = range.loc.end.line > line || (range.loc.end.line === line && range.loc.end.column >= column);

        if (startsBefore && endsAfter) {
            if (candidate === null || range.end - range.start < candidate.end - candidate.start) {
                candidate = range;
            }
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

export function getFunctionRanges(code: string, url?: string | null): FunctionRange[] {
    let ast;

    try {
        ast = parse(code, {
            sourceType: 'unambiguous'
            // plugins: ['typescript', 'jsx'],
            // ranges: true,
            // errorRecovery: true
        });
    } catch (e) {
        console.error(`Failed to parse ${url ? `"${url}"` : 'source'} for function ranges:`, e);
        return [];
    }

    const result: FunctionRange[] = [];

    function isFunctionNode(n) {
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

    function findCallFrameStart(node) {
        if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
            return code.indexOf('(', node.start);
        }
        if (node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod' || node.type === 'ObjectMethod') {
            return code.indexOf('(', node.key.end);
        }
    }

    function getFunctionName(node, parent) {
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

    function walk(node, parent = null) {
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

            result.push({
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
                for (const item of v) {
                    walk(item, node);
                }
            } else if (v && typeof v.type === 'string') {
                walk(v, node);
            }
        }
    }

    walk(ast);
    result.sort((a, b) => a.start - b.start || a.end - b.end);
    return result;
}
