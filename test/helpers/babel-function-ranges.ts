import { parse } from '@babel/parser';
import type { FunctionRange } from '../../app/prepare/misc/parse-script-source-ranges.js';

// Function ranges of a source by a syntax tree of @babel/parser: an independent parse to compare
// parseScriptSourceRanges() with. Kinds, boundaries and leading comments come from the tree; names and call frame
// starts follow the contract of the ranges:
// - a function is named by its own name, a non-computed key, or as the value of a variable, an assignment
//   to an identifier, a property, an enum member or a parameter with a default value; an operand of an operator,
//   a computed key or a superclass doesn't name a function, since V8 doesn't name it after them;
// - a call frame of a function or a method starts at its parameters, after its type parameters
type Node = {
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

const functionTypes = new Set([
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
]);
const keyedSlotTypes = new Set([
    'ObjectProperty',
    'ClassProperty',
    'ClassPrivateProperty',
    'ClassAccessorProperty'
]);

// Ranges ordered as parseScriptSourceRanges() orders them, without self sizes; throws for a source babel can't parse
export function parseFunctionRangesWithBabel(code: string, url: string): FunctionRange[] {
    const result = parse(code, {
        sourceType: 'unambiguous',
        plugins: pluginsFor(url),
        tokens: true
    });
    const ast = result as unknown as Node;
    const parenStarts = openingParenStarts(result.tokens as Node[]);
    const ranges: FunctionRange[] = [];
    const walk = (node: Node, parent: Node | null) => {
        if (functionTypes.has(node.type)) {
            ranges.push(createRange(node, parent, code, parenStarts));
        }

        for (const key of Object.keys(node)) {
            const value = node[key];

            if (Array.isArray(value)) {
                for (const item of value) {
                    if (item !== null && typeof item === 'object' && typeof item.type === 'string') {
                        walk(item, node);
                    }
                }
            } else if (value !== null && typeof value === 'object' && typeof value.type === 'string') {
                walk(value, node);
            }
        }
    };

    walk(ast, null);

    return ranges.sort((a, b) => a.callFrameStart - b.callFrameStart || b.end - a.end);
}

function pluginsFor(url: string): ('typescript' | 'jsx' | 'decorators')[] {
    if (JSX_REGEX.test(url)) {
        return ['typescript', 'jsx', 'decorators'];
    }

    if (TS_REGEX.test(url)) {
        return ['typescript', 'decorators'];
    }

    return [];
}

// Starts of ( tokens, ascending; comments aren't tokens
function openingParenStarts(tokens: Node[]) {
    const starts: number[] = [];

    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].type.label === '(') {
            starts.push(tokens[i].start);
        }
    }

    return starts;
}

// The first ( token at or after an offset
function parenStartAfter(parenStarts: number[], offset: number) {
    let left = 0;
    let right = parenStarts.length;

    while (left < right) {
        const middle = (left + right) >>> 1;

        if (parenStarts[middle] < offset) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    return parenStarts[left];
}

function createRange(node: Node, parent: Node | null, code: string, parenStarts: number[]) {
    const callFrameStart = callFrameStartOf(node, parenStarts);
    const leadingComment = node.leadingComments?.[0];
    let callFrameStartLine = node.loc.start.line;
    let callFrameStartColumn = node.loc.start.column;

    for (let offset = node.start; offset < callFrameStart; offset++) {
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

    return {
        type: node.type,
        name: nameOf(node, parent),
        defaultConstructor: isClassWithoutConstructor(node),
        start: leadingComment !== undefined ? leadingComment.start : node.start,
        end: node.end,
        endLine: node.loc.end.line,
        endColumn: node.loc.end.column,
        callFrameStart,
        callFrameStartLine,
        callFrameStartColumn,
        selfSize: 0
    };
}

// A call frame of a function or a method starts at the ( token of its parameters
function callFrameStartOf(node: Node, parenStarts: number[]) {
    switch (node.type) {
        case 'FunctionDeclaration':
        case 'FunctionExpression':
            return parenStartAfter(parenStarts, node.typeParameters?.end ?? node.id?.end ?? node.start);

        case 'ClassMethod':
        case 'ClassPrivateMethod':
        case 'ObjectMethod':
            return parenStartAfter(parenStarts, node.typeParameters?.end ?? node.key.end);
    }

    return node.start;
}

function isClassWithoutConstructor(node: Node) {
    if (node.type !== 'ClassDeclaration' && node.type !== 'ClassExpression') {
        return false;
    }

    return !node.body.body.some((member: Node) => member.kind === 'constructor');
}

// A name of a non-computed key: an identifier, a private name as V8 names it, or a string
function keyName(key: Node, computed: boolean) {
    if (computed) {
        return '';
    }

    switch (key.type) {
        case 'PrivateName':
            return '#' + key.id.name;
        case 'Identifier':
            return key.name;
        case 'StringLiteral':
            return key.value;
    }

    return '';
}

function nameOf(node: Node, parent: Node | null) {
    if (node.id) {
        return node.id.name;
    }

    if (node.key) {
        return keyName(node.key, node.computed);
    }

    switch (parent?.type) {
        case 'VariableDeclarator':
            return parent.init === node && parent.id.type === 'Identifier'
                ? parent.id.name
                : '';

        case 'TSEnumMember':
            return keyName(parent.id, false);

        case 'AssignmentExpression':
        case 'AssignmentPattern':
            return parent.right === node && parent.left.type === 'Identifier'
                ? parent.left.name
                : '';
    }

    if (keyedSlotTypes.has(parent?.type ?? '') && parent!.value === node) {
        return keyName(parent!.key, parent!.computed);
    }

    return '';
}
