import { parse } from '@babel/parser';

export type FunctionRanges = {
    parsed: boolean;
    error?: string;
    ranges: FunctionRange[];
    starts: Uint32Array<ArrayBuffer>;
    indexes: Int32Array<ArrayBuffer>;
    parents: Int32Array<ArrayBuffer>; // per range: the nearest enclosing range, -1 for a top-level range
};
export type FunctionRange = {
    type: string;
    name: string;
    defaultConstructor: boolean;
    callFrameStart: number;
    callFrameStartLine: number;
    callFrameStartColumn: number;
    start: number;
    startLine: number;
    startColumn: number;
    end: number;
    endLine: number;
    endColumn: number;
    selfSize: number;
}
// Function ranges of several scripts as columns, the ranges of a script follow the ranges of the previous one;
// a type is an index in a list of types
export type FunctionRangeColumns = {
    [Field in Exclude<keyof FunctionRange, 'type' | 'name' | 'defaultConstructor'>]: Uint32Array<ArrayBuffer>;
} & {
    type: Uint8Array<ArrayBuffer>;
    name: string[];
    defaultConstructor: Uint8Array<ArrayBuffer>;
};
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

const functionRangeTypes = [
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'ClassDeclaration',
    'ClassExpression',
    'ClassMethod',
    'ClassPrivateMethod',
    'ObjectMethod',
    'TSDeclareFunction',
    'TSEnumDeclaration'
];

export function createFunctionRangeColumns(count: number): FunctionRangeColumns {
    return {
        type: new Uint8Array(count),
        name: new Array(count),
        defaultConstructor: new Uint8Array(count),
        start: new Uint32Array(count),
        end: new Uint32Array(count),
        startLine: new Uint32Array(count),
        startColumn: new Uint32Array(count),
        endLine: new Uint32Array(count),
        endColumn: new Uint32Array(count),
        callFrameStart: new Uint32Array(count),
        callFrameStartLine: new Uint32Array(count),
        callFrameStartColumn: new Uint32Array(count),
        selfSize: new Uint32Array(count)
    };
}

export function writeFunctionRanges(
    columns: FunctionRangeColumns,
    offset: number,
    ranges: FunctionRange[],
    types: Map<string, number>
) {
    for (let i = 0; i < ranges.length; i++) {
        const range = ranges[i];
        const index = offset + i;
        let type = types.get(range.type);

        if (type === undefined) {
            type = types.size;
            types.set(range.type, type);
        }

        columns.type[index] = type;
        columns.name[index] = range.name;
        columns.defaultConstructor[index] = range.defaultConstructor ? 1 : 0;
        columns.start[index] = range.start;
        columns.end[index] = range.end;
        columns.startLine[index] = range.startLine;
        columns.startColumn[index] = range.startColumn;
        columns.endLine[index] = range.endLine;
        columns.endColumn[index] = range.endColumn;
        columns.callFrameStart[index] = range.callFrameStart;
        columns.callFrameStartLine[index] = range.callFrameStartLine;
        columns.callFrameStartColumn[index] = range.callFrameStartColumn;
        columns.selfSize[index] = range.selfSize;
    }
}

export function readFunctionRanges(
    columns: FunctionRangeColumns,
    offset: number,
    count: number,
    types: string[]
): FunctionRange[] {
    const ranges: FunctionRange[] = new Array(count);

    for (let i = 0; i < count; i++) {
        const index = offset + i;

        // the property order of collectFunctionRangesFromAST() keeps a single shape for all ranges
        ranges[i] = {
            type: types[columns.type[index]],
            name: columns.name[index],
            defaultConstructor: columns.defaultConstructor[index] === 1,
            start: columns.start[index],
            end: columns.end[index],
            startLine: columns.startLine[index],
            startColumn: columns.startColumn[index],
            endLine: columns.endLine[index],
            endColumn: columns.endColumn[index],
            callFrameStart: columns.callFrameStart[index],
            callFrameStartLine: columns.callFrameStartLine[index],
            callFrameStartColumn: columns.callFrameStartColumn[index],
            selfSize: columns.selfSize[index]
        };
    }

    return ranges;
}

function computeSelfSize(functionRanges: FunctionRanges): void {
    const { starts, indexes, ranges } = functionRanges;

    // The index ends with the end of the last top-level range, so its last entry always belongs to the script
    for (let i = 0; i < starts.length - 1; i++) {
        const rangeIndex = indexes[i];

        if (rangeIndex !== -1) {
            ranges[rangeIndex].selfSize += starts[i + 1] - starts[i];
        }
    }
}

export function parseScriptSourceRanges(
    code: string,
    url?: string | null,
    fromWorker?: boolean
): FunctionRanges {
    if (!fromWorker) {
        console.warn('parseScriptSourceRanges should be called from a worker thread for performance reasons', { url, code });
    }

    let ast: ASTNode | null = null;
    const functionRanges: FunctionRanges = {
        parsed: false,
        ranges: [],
        starts: new Uint32Array(),
        indexes: new Int32Array(),
        parents: new Int32Array()
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
        functionRanges.error = e.message;
        return functionRanges;
    }

    functionRanges.ranges = collectFunctionRangesFromAST(ast, code)
        .sort((a, b) => a.callFrameStart - b.callFrameStart || b.end - a.end);

    // build index for faster search
    if (functionRanges.ranges.length > 0) {
        Object.assign(functionRanges, buildFunctionRangesIndex(functionRanges));
        computeSelfSize(functionRanges);
    }

    functionRanges.parsed = true;

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
            let hasDefaultConstructor = false;

            if (callFrameStart > nodeStart) {
                for (let offset = nodeStart; offset < callFrameStart; offset++) {
                    const char = code.charCodeAt(offset);

                    if (char === 10 || char === 13 || char === 0x2028 || char === 0x2029) {
                        callFrameStartLine++;
                        callFrameStartColumn = 0;

                        if (char === 13 && code.charCodeAt(offset + 1) === 10) {
                            offset++;
                        }
                    } else {
                        callFrameStartColumn++;
                    }
                }
            }

            if (node.leadingComments && node.leadingComments.length > 0) {
                nodeStartWithComments = node.leadingComments[0].start;
                locStart = node.leadingComments[0].loc.start;
            }

            if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
                hasDefaultConstructor = !node.body.body.some((member: ASTNode) => member.kind === 'constructor');
            }

            ranges.push({
                type: node.type,
                name: getFunctionName(node, parent),
                defaultConstructor: hasDefaultConstructor,
                start: nodeStartWithComments,
                end: node.end,
                // slice: code.slice(nodeStartWithComments, node.end),
                startLine: locStart.line,
                startColumn: locStart.column,
                endLine: node.loc.end.line,
                endColumn: node.loc.end.column,
                callFrameStart,
                callFrameStartLine,
                callFrameStartColumn,
                selfSize: 0
            });
        }

        // simple recursive walk
        for (const key of Object.keys(node)) {
            const v = node[key];

            // only objects can be nodes or arrays of nodes; testing primitives for a type property
            // goes through their prototypes and is a significant part of the walk
            if (v === null || typeof v !== 'object') {
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

    return functionRangeTypes.includes(n.type);
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

// V8 names a function after a private class member with its hash, e.g. `#method`
function getKeyName(key: ASTNode | null | undefined): string | null {
    if (!key) {
        return null;
    }

    if (key.type === 'PrivateName') {
        return '#' + key.id.name;
    }

    if (typeof key.name === 'string') {
        return key.name;
    }

    if (typeof key.value === 'string') {
        return key.value;
    }

    return null;
}

function getFunctionName(node: ASTNode, parent: ASTNode | null): string {
    if (node.id && typeof node.id.name === 'string') {
        return node.id.name;
    }

    const keyName = getKeyName(node.key);

    if (keyName !== null) {
        return keyName;
    }

    if (parent) {
        if (parent.id && typeof parent.id.name === 'string') {
            return parent.id.name;
        }

        const parentKeyName = getKeyName(parent.key);

        if (parentKeyName !== null) {
            return parentKeyName;
        }

        if (parent.left && typeof parent.left.name === 'string') {
            return parent.left.name;
        }
    }

    return '';
}

function buildFunctionRangesIndex({ ranges }: FunctionRanges) {
    const rangeStarts: number[] = [0];
    const rangeIndexes: number[] = [-1];
    const parents = new Int32Array(ranges.length);
    const stack: number[] = [-1];
    let lastPos = 0;

    for (let i = 0; i < ranges.length; i++) {
        const range = ranges[i];

        while (stack.length > 1) {
            const top = stack[stack.length - 1];
            const end = ranges[top].end;

            if (end > range.callFrameStart) {
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

        if (lastPos < range.callFrameStart) {
            lastPos = range.callFrameStart;
            rangeStarts.push(range.callFrameStart);
            rangeIndexes.push(i);
        } else {
            rangeIndexes[rangeIndexes.length - 1] = i;
        }

        // ranges ending before this one starts are popped, so the stack holds its enclosing ranges
        parents[i] = stack[stack.length - 1];
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
        indexes: new Int32Array(rangeIndexes),
        parents
    };
}
