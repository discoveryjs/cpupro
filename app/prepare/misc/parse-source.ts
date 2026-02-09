import { parse } from '@babel/parser';
import { CpuProScript } from '../types';
import { createLineBoundaries } from './line-boundaries';

type FunctionRange = {
    type: string;
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
        functionRanges = getFunctionRanges(script.source);
        scriptFunctionRanges.set(script, functionRanges);
    }
    return functionRanges;
}

export function findFunctionAtPosition(functionRanges: FunctionRange[], position: number) {
    for (const range of functionRanges) {
        if (range.start <= position && position <= range.end) {
            return range;
        }
    }

    return null;
}

export function findFunctionAtLineColumn(functionRanges: FunctionRange[], line: number, column: number) {
    let candidate: FunctionRange | null = null;

    for (const range of functionRanges) {
        if (range.loc.start.line === line) {
            if (range.loc.start.column <= column) {
                candidate = range;
            }
        }
    }

    return candidate;
}

export function getPosFromScriptLineColumn(script: CpuProScript | null, line: number, column: number) {
    const lines = getScriptLineBoundaries(script);

    if (lines) {
        return lines.getOffset(line + 1, column + 1);
    }

    return -1;
}

export function getFunctionEndFromScriptLineColumn(script: CpuProScript | null, line: number, column: number, fn) {
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

export function getFunctionRanges(code: string) {
    let ast;

    try {
        ast = parse(code, {
            sourceType: 'unambiguous',
            plugins: ['typescript', 'jsx'],
            ranges: true,
            errorRecovery: true
        });
    } catch (e) {
        console.error('Failed to parse source for function ranges:', e);
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
            n.type === 'ObjectMethod' ||
            n.type === 'ClassMethod' ||
            n.type === 'ClassPrivateMethod' ||
            n.type === 'TSDeclareFunction'
        );
    }

    function walk(node) {
        if (!node || typeof node !== 'object') {
            return;
        }

        if (isFunctionNode(node)) {
            result.push({
                type: node.type,
                start: node.start,
                // slice: code.slice(node.start, node.end),
                end: node.end,
                loc: node.loc
            });
        }

        // очень простой универсальный обход:
        for (const key of Object.keys(node)) {
            const v = node[key];
            if (!v) {
                continue;
            }

            if (Array.isArray(v)) {
                for (const item of v) {
                    walk(item);
                }
            } else if (v && typeof v.type === 'string') {
                walk(v);
            }
        }
    }

    walk(ast);
    return result;
}
