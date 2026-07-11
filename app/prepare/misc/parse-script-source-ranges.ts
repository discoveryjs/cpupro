import { parse } from '@babel/parser';

export type FunctionRanges = {
    ranges: FunctionRange[];
    starts: number[];
    indexes: number[];
};
export type FunctionRange = {
    type: string;
    name: string;
    callFrameStart: number;
    callFrameStartLine: number;
    callFrameStartColumn: number;
    start: number;
    startLine: number;
    startColumn: number;
    end: number;
    endLine: number;
    endColumn: number;
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

const JSX_REGEX = /\.[mc]?[tj]sx($|[\?\#\|])/;
const TS_REGEX = /\.[mc]?ts($|[\?\#\|])/;

export function parseScriptSourceRanges(code: string, url?: string | null, fromWorker?: boolean): FunctionRanges {
    if (!fromWorker) {
        console.warn('parseScriptSourceRanges should be called from a worker thread for performance reasons', { url, code });
    }

    let ast: ASTNode | null = null;
    const functionRanges: FunctionRanges = {
        ranges: [],
        starts: [],
        indexes: []
    };

    try {
        ast = parse(code, {
            sourceType: 'unambiguous',
            plugins: JSX_REGEX.test(url || '')
                ? ['typescript', 'jsx', 'decorators']
                : TS_REGEX.test(url || '')
                    ? ['typescript', 'decorators']
                    : []
            // ranges: true,
            // errorRecovery: true
        }) as ASTNode;
    } catch (e) {
        console.error(`Failed to parse ${url ? `"${url}"` : '<no url>'} for function ranges:`, e.message);
        return functionRanges;
    }

    functionRanges.ranges = collectFunctionRangesFromAST(ast, code)
        .sort((a, b) => a.start - b.start || b.end - a.end);

    // build index for faster search
    if (functionRanges.ranges.length > 0) {
        Object.assign(functionRanges, buildFunctionRangesIndex(functionRanges));
    }

    return functionRanges;
}

function collectFunctionRangesFromAST(ast: ASTNode, code: string): FunctionRange[] {
    const ranges: FunctionRange[] = [];

    walk(ast);

    return ranges;

    function walk(node: ASTNode, parent: ASTNode | null = null) {
        if (!node || typeof node !== 'object') {
            return;
        }

        if (isFunctionNode(node)) {
            const nodeStart = node.start || 0;
            const callFrameStart = findCallFrameStart(node, code, nodeStart);
            let callFrameStartLine = node.loc.start.line;
            let callFrameStartColumn = node.loc.start.column;
            let nodeStartWithComments = nodeStart;
            let locStart = node.loc.start;

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

            if (node.leadingComments && node.leadingComments.length > 0) {
                nodeStartWithComments = node.leadingComments[0].start;
                locStart = node.leadingComments[0].loc.start;
            }

            ranges.push({
                type: node.type,
                name: getFunctionName(node, parent),
                start: nodeStartWithComments,
                end: node.end,
                // slice: code.slice(nodeStartWithComments, node.end),
                startLine: locStart.line,
                startColumn: locStart.column,
                endLine: node.loc.end.line,
                endColumn: node.loc.end.column,
                callFrameStart,
                callFrameStartLine,
                callFrameStartColumn
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
        n.type === 'TSDeclareFunction' ||
        n.type === 'TSEnumDeclaration'
    );
}

function findCallFrameStart(node: ASTNode, code: string, fallbackStart: number): number {
    let callFrameStart = -1;

    if (node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression'
    ) {
        callFrameStart = code.indexOf('(', node.start);
    } else if (
        node.type === 'ClassMethod' ||
        node.type === 'ClassPrivateMethod' ||
        node.type === 'ObjectMethod'
    ) {
        callFrameStart = code.indexOf('(', node.key.end);
    }

    return callFrameStart !== -1 ? callFrameStart : fallbackStart;
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

function buildFunctionRangesIndex({ ranges }: FunctionRanges) {
    const rangeStarts: number[] = ranges[0].start !== 0 ? [0] : [];
    const rangeIndexes: number[] = ranges[0].start !== 0 ? [-1] : [];
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
                rangeIndexes.push(stack[stack.length - 1]);
            } else {
                rangeIndexes[rangeIndexes.length - 1] = stack[stack.length - 1];
            }
        }

        if (lastPos < range.start) {
            lastPos = range.start;
            rangeStarts.push(range.start);
            rangeIndexes.push(i);
        } else {
            rangeIndexes[rangeIndexes.length - 1] = i;
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
            rangeIndexes.push(stack[stack.length - 1]);
        } else {
            rangeIndexes[rangeIndexes.length - 1] = stack[stack.length - 1];
        }
    }

    return {
        starts: new Uint32Array(rangeStarts),
        indexes: new Int32Array(rangeIndexes)
    };
}
