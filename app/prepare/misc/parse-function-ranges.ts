import {
    AMPERSAND,
    ARROW,
    ASSIGN,
    AT,
    BANG,
    BRACE_L,
    BRACE_R,
    BRACKET_L,
    BRACKET_R,
    COLON,
    COMMA,
    DOT,
    ELLIPSIS,
    EOF,
    GT,
    INC_DEC,
    KW_ABSTRACT,
    KW_ACCESSOR,
    KW_AS,
    KW_ASSERT,
    KW_ASSERTS,
    KW_ASYNC,
    KW_AWAIT,
    KW_BREAK,
    KW_CASE,
    KW_CATCH,
    KW_CLASS,
    KW_CONST,
    KW_CONSTRUCTOR,
    KW_CONTINUE,
    KW_DEBUGGER,
    KW_DECLARE,
    KW_DEFAULT,
    KW_DELETE,
    KW_DO,
    KW_ELSE,
    KW_ENUM,
    KW_EXPORT,
    KW_EXTENDS,
    KW_FINALLY,
    KW_FOR,
    KW_FROM,
    KW_FUNCTION,
    KW_GET,
    KW_GLOBAL,
    KW_IF,
    KW_IMPLEMENTS,
    KW_IMPORT,
    KW_IN,
    KW_INFER,
    KW_INTERFACE,
    KW_IS,
    KW_KEYOF,
    KW_LET,
    KW_MODULE,
    KW_NAMESPACE,
    KW_NEW,
    KW_OF,
    KW_OVERRIDE,
    KW_PRIVATE,
    KW_PROTECTED,
    KW_PUBLIC,
    KW_READONLY,
    KW_RETURN,
    KW_SATISFIES,
    KW_SET,
    KW_STATIC,
    KW_SWITCH,
    KW_THROW,
    KW_TRY,
    KW_TYPE,
    KW_TYPEOF,
    KW_UNIQUE,
    KW_USING,
    KW_VAR,
    KW_VOID,
    KW_WHILE,
    KW_WITH,
    KW_YIELD,
    LT,
    NAME,
    NONE,
    NUMBER,
    OPERATOR_ASSIGN,
    PAREN_L,
    PAREN_R,
    PIPE,
    PLUS_MINUS,
    PREC_EXPONENT,
    PRIVATE_NAME,
    QUESTION,
    QUESTION_DOT,
    REGEXP,
    SEMICOLON,
    SLASH,
    SourceLexer,
    STAR,
    STRING,
    TEMPLATE,
    TEMPLATE_HEAD,
    TILDE
} from './source-lexer.js';

// Function ranges of a JavaScript, TypeScript or JSX source by a single pass over its tokens, without a syntax
// tree: the grammar is followed only as far as kinds, boundaries and names of functions and classes depend on it,
// types are skipped. A range is recorded once its function is complete, so nested functions come before it.
//
// A function, an arrow function or a class that is the whole expression of a slot – a value of a variable,
// a property or an assignment, an argument, an operand and so on – takes the comments right before the slot
// into its range, as the leading comments of its syntax tree node; a slot of a variable, an assignment target,
// a property, an enum member or a parameter with a default value names a function without a name of its own

export const functionRangeTypes = [
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

const FUNCTION_DECLARATION: number = 0;
const FUNCTION_EXPRESSION: number = 1;
const ARROW_FUNCTION: number = 2;
const CLASS_DECLARATION: number = 3;
const CLASS_EXPRESSION: number = 4;
const CLASS_METHOD: number = 5;
const CLASS_PRIVATE_METHOD: number = 6;
const OBJECT_METHOD: number = 7;
const TS_DECLARE_FUNCTION: number = 8;
const TS_ENUM_DECLARATION: number = 9;

export type ParsedFunctionRanges = {
    count: number;
    type: number[]; // an index in functionRangeTypes
    name: (string | null)[]; // null for a function named neither by itself nor by its slot
    defaultConstructor: boolean[]; // a class without a constructor of its own
    start: number[]; // with the leading comments
    callFrameStart: number[]; // where V8 starts a function: its parameters, or an arrow function or a class start
    end: number[];
};

// Parsing flags
const FOR_INIT: number = 1; // `in` isn't an operator in the head of a for statement
const MAYBE_PARAMS: number = 2; // an element of parentheses, which may turn out to be a typed parameter
const HERITAGE: number = 4; // a superclass, type arguments may follow it

// Tokens that can start an expression
const startsExpression = new Uint8Array(SLASH + 1);
const expressionStartTokens = [
    NAME,
    PRIVATE_NAME,
    NUMBER,
    STRING,
    TEMPLATE,
    TEMPLATE_HEAD,
    REGEXP,
    PAREN_L,
    BRACKET_L,
    BRACE_L,
    LT,
    PLUS_MINUS,
    INC_DEC,
    BANG,
    TILDE,
    AT
];

for (let i = 0; i < expressionStartTokens.length; i++) {
    startsExpression[expressionStartTokens[i]] = 1;
}

// Modifiers of class members
const classModifiers = new Uint8Array(KW_YIELD + 1);
const classModifierWords = [
    KW_STATIC,
    KW_ASYNC,
    KW_GET,
    KW_SET,
    KW_PUBLIC,
    KW_PRIVATE,
    KW_PROTECTED,
    KW_READONLY,
    KW_ABSTRACT,
    KW_OVERRIDE,
    KW_DECLARE,
    KW_ACCESSOR
];

for (let i = 0; i < classModifierWords.length; i++) {
    classModifiers[classModifierWords[i]] = 1;
}

const lexer = new SourceLexer();
let jsx = false;
let ranges: ParsedFunctionRanges;

// Throws a SyntaxError for a source it can't parse
export function parseFunctionRanges(source: string, typescript: boolean, jsxEnabled: boolean): ParsedFunctionRanges {
    const parsed: ParsedFunctionRanges = {
        count: 0,
        type: [],
        name: [],
        defaultConstructor: [],
        start: [],
        callFrameStart: [],
        end: []
    };

    jsx = jsxEnabled;
    ranges = parsed;

    try {
        lexer.reset(source, typescript);

        while (lexer.type !== EOF) {
            parseStatement();
        }
    } finally {
        // the lexer doesn't retain the source between parses
        lexer.reset('', false);
    }

    return parsed;
}

//
// Ranges
//

function addRange(
    type: number,
    start: number,
    callFrameStart: number,
    end: number,
    name: string | null,
    defaultConstructor: boolean
) {
    ranges.type.push(type);
    ranges.name.push(name);
    ranges.defaultConstructor.push(defaultConstructor);
    ranges.start.push(start);
    ranges.callFrameStart.push(callFrameStart);
    ranges.end.push(end);

    return ranges.count++;
}

// The start of a declaration with its leading comments
function leadingStart(start: number, commentStart: number) {
    return commentStart !== NONE
        ? commentStart
        : start;
}

// A function taking a whole slot gets the comments before the slot and the slot's name unless it has one
function takeSlot(
    range: number, // NONE when the slot's expression isn't a function
    commentStart: number,
    nameStart: number, // NONE for a slot without a name
    nameEnd: number
) {
    if (range === NONE) {
        return;
    }

    if (commentStart !== NONE && commentStart < ranges.start[range]) {
        ranges.start[range] = commentStart;
    }

    if (nameStart !== NONE && ranges.name[range] === null) {
        ranges.name[range] = nameAt(nameStart, nameEnd);
    }
}

// The start of the name of a property key or a binding at the current token, NONE when it has no name
function nameStartAt() {
    return lexer.type === NAME || lexer.type === STRING || lexer.type === PRIVATE_NAME
        ? lexer.start
        : NONE;
}

const escapedChars: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', 0: '\0' };
const escapePattern = /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\r\n\u2028\u2029])|(.))/gs;

function decodeEscape(
    match: string,
    codePoint: string | undefined,
    unicode: string | undefined,
    hex: string | undefined,
    lineContinuation: string | undefined,
    char: string | undefined
) {
    const code = codePoint ?? unicode ?? hex;

    if (code !== undefined) {
        return String.fromCodePoint(parseInt(code, 16));
    }

    if (lineContinuation !== undefined) {
        return '';
    }

    return escapedChars[char!] ?? char!;
}

// The name of an identifier, a private name or a string literal, with escapes decoded
function nameAt(start: number, end: number) {
    const source = lexer.source;
    const quote = source.charCodeAt(start);
    const name = quote === 34 /* " */ || quote === 39 /* ' */
        ? source.slice(start + 1, end - 1)
        : source.slice(start, end);

    return name.indexOf('\\') !== -1
        ? name.replace(escapePattern, decodeEscape)
        : name;
}

//
// Tokens
//

function expect(type: number) {
    if (lexer.type !== type) {
        lexer.unexpected();
    }
}

function isWord(word: number) {
    return lexer.type === NAME && lexer.word === word;
}

// Reads the comma after an item of a list, stays at the token closing the list
function nextListItem(close: number) {
    if (lexer.type === COMMA) {
        lexer.next();
    } else if (lexer.type !== close) {
        lexer.unexpected();
    }
}

function consumeSemicolon() {
    if (lexer.type === SEMICOLON) {
        lexer.next();
    }
}

// Whether the next token is a name on the same line, i.e. the current word starts a declaration
function declarationFollows() {
    lexer.peek();

    return lexer.peekType === NAME && !lexer.peekNewlineBefore;
}

//
// Statements
//

function parseStatement() {
    const start = lexer.start;
    const commentStart = lexer.commentStart;

    switch (lexer.type) {
        case BRACE_L:
            parseBody();
            lexer.next();
            return;

        case SEMICOLON:
            lexer.next();
            return;

        case AT:
            parseDecorators();
            parseDecoratedClass(start, commentStart);
            return;

        case NAME:
            if (lexer.word !== 0 && parseWordStatement(start, commentStart)) {
                return;
            }
            break;
    }

    // the statement takes the comments before it, its expression takes no slot
    parseSequence(0);

    // a label
    if (lexer.type === COLON) {
        lexer.next();
        parseStatement();
        return;
    }

    consumeSemicolon();
}

// Statements of a block or a body from its opening brace, the current token is its closing brace then
function parseBody() {
    lexer.next();

    while (lexer.type !== BRACE_R) {
        if (lexer.type === EOF) {
            lexer.unexpected();
        }

        parseStatement();
    }
}

// A statement starting with a word; false when the word starts an expression statement
function parseWordStatement(start: number, commentStart: number) {
    switch (lexer.word) {
        case KW_FUNCTION:
            parseFunction(true, start, commentStart);
            return true;

        case KW_ASYNC:
            lexer.peek();

            if (lexer.peekWord !== KW_FUNCTION || lexer.peekNewlineBefore) {
                return false;
            }

            lexer.next();
            parseFunction(true, start, commentStart);
            return true;

        case KW_CLASS:
            parseClass(CLASS_DECLARATION, start, commentStart);
            return true;

        case KW_CONST:
            if (lexer.typescript) {
                lexer.peek();

                if (lexer.peekWord === KW_ENUM) {
                    lexer.next();
                    parseEnum(start, commentStart);
                    return true;
                }
            }

            parseVariableDeclaration(0);
            consumeSemicolon();
            return true;

        case KW_VAR:
            parseVariableDeclaration(0);
            consumeSemicolon();
            return true;

        case KW_LET:
        case KW_USING:
            if (!isDeclarationWord()) {
                return false;
            }

            parseVariableDeclaration(0);
            consumeSemicolon();
            return true;

        case KW_IF:
            lexer.next();
            parseParenthesizedHead();
            parseStatement();

            if (isWord(KW_ELSE)) {
                lexer.next();
                parseStatement();
            }
            return true;

        case KW_FOR:
            parseFor();
            return true;

        case KW_WHILE:
        case KW_WITH:
            lexer.next();
            parseParenthesizedHead();
            parseStatement();
            return true;

        case KW_DO:
            lexer.next();
            parseStatement();

            if (!isWord(KW_WHILE)) {
                lexer.unexpected();
            }

            lexer.next();
            parseParenthesizedHead();
            consumeSemicolon();
            return true;

        case KW_SWITCH:
            parseSwitch();
            return true;

        case KW_TRY:
            parseTry();
            return true;

        case KW_RETURN:
        case KW_THROW:
            lexer.next();

            if (lexer.type !== SEMICOLON && lexer.type !== BRACE_R && lexer.type !== EOF && !lexer.newlineBefore) {
                parseSlotSequence(0);
            }

            consumeSemicolon();
            return true;

        case KW_BREAK:
        case KW_CONTINUE:
            lexer.next();

            if (lexer.type === NAME && !lexer.newlineBefore) {
                lexer.next();
            }

            consumeSemicolon();
            return true;

        case KW_DEBUGGER:
            lexer.next();
            consumeSemicolon();
            return true;

        case KW_EXPORT:
            parseExport();
            return true;

        case KW_IMPORT:
            lexer.peek();

            // import() and import.meta
            if (lexer.peekType === PAREN_L || lexer.peekType === DOT) {
                return false;
            }

            parseImport();
            return true;
    }

    return lexer.typescript && parseTypeScriptStatement(start, commentStart);
}

// Whether `let` or `using` declares variables rather than names one
function isDeclarationWord() {
    const word = lexer.word;

    lexer.peek();

    if (word === KW_USING) {
        return lexer.peekType === NAME && !lexer.peekNewlineBefore;
    }

    return lexer.peekType === NAME || lexer.peekType === BRACKET_L || lexer.peekType === BRACE_L;
}

function parseParenthesizedHead() {
    expect(PAREN_L);
    lexer.next();
    parseSlotSequence(0);
    expect(PAREN_R);
    lexer.next();
}

function parseVariableDeclaration(flags: number) {
    do {
        // after var, let, const, using or a comma
        lexer.next();

        const nameStart = lexer.type === NAME
            ? lexer.start
            : NONE;
        const nameEnd = lexer.end;

        parseBinding();

        if (lexer.typescript) {
            skipDefiniteAndType();
        }

        if (lexer.type === ASSIGN) {
            lexer.next();
            parseSlot(nameStart, nameEnd, flags);
        }
    } while (lexer.type === COMMA);
}

// A binding name or a pattern
function parseBinding() {
    switch (lexer.type) {
        case NAME:
            lexer.nextAfterOperand();
            return;

        case BRACE_L:
            parseObjectLiteral();
            return;

        case BRACKET_L:
            parseArrayLiteral();
            return;
    }

    lexer.unexpected();
}

function parseFor() {
    lexer.next();

    if (isWord(KW_AWAIT)) {
        lexer.next();
    }

    expect(PAREN_L);
    lexer.next();

    if (lexer.type !== SEMICOLON) {
        parseForInit();
    }

    if (isWord(KW_OF) || isWord(KW_IN)) {
        lexer.next();
        parseSlotSequence(0);
    } else {
        expect(SEMICOLON);
        lexer.next();

        if (lexer.type !== SEMICOLON) {
            parseSlotSequence(0);
        }

        expect(SEMICOLON);
        lexer.next();

        if (lexer.type !== PAREN_R) {
            parseSlotSequence(0);
        }
    }

    expect(PAREN_R);
    lexer.next();
    parseStatement();
}

function parseForInit() {
    const word = lexer.word;

    if (word === KW_VAR || word === KW_CONST || word === KW_LET || word === KW_USING) {
        lexer.peek();

        if (lexer.peekType === NAME || lexer.peekType === BRACE_L || lexer.peekType === BRACKET_L) {
            parseVariableDeclaration(FOR_INIT);
            return;
        }
    }

    parseSlotSequence(FOR_INIT);
}

function parseSwitch() {
    lexer.next();
    parseParenthesizedHead();
    expect(BRACE_L);
    lexer.next();

    while (lexer.type !== BRACE_R) {
        if (isWord(KW_CASE)) {
            lexer.next();
            parseSlotSequence(0);
            expect(COLON);
            lexer.next();
        } else if (isWord(KW_DEFAULT)) {
            lexer.next();
            expect(COLON);
            lexer.next();
        } else if (lexer.type === EOF) {
            lexer.unexpected();
        } else {
            parseStatement();
        }
    }

    lexer.next();
}

function parseTry() {
    lexer.next();
    expect(BRACE_L);
    parseBody();
    lexer.next();

    if (isWord(KW_CATCH)) {
        lexer.next();

        if (lexer.type === PAREN_L) {
            lexer.next();
            parseBinding();

            if (lexer.typescript) {
                skipDefiniteAndType();
            }

            expect(PAREN_R);
            lexer.next();
        }

        expect(BRACE_L);
        parseBody();
        lexer.next();
    }

    if (isWord(KW_FINALLY)) {
        lexer.next();
        expect(BRACE_L);
        parseBody();
        lexer.next();
    }
}

//
// Modules
//

// The comments before `export` belong to the export, a declaration takes the comments after it
function parseExport() {
    lexer.next();

    const start = lexer.start;
    const commentStart = lexer.commentStart;

    if (lexer.type === AT) {
        parseDecorators();
        parseDecoratedClass(start, commentStart);
        return;
    }

    if (isWord(KW_DEFAULT)) {
        parseExportDefault();
        return;
    }

    if (lexer.type === BRACE_L || lexer.type === STAR || isTypeOnlyExportList()) {
        skipExportList();
        return;
    }

    if (lexer.typescript && parseTypeScriptExport()) {
        return;
    }

    if (lexer.type !== NAME || !parseWordStatement(start, commentStart)) {
        lexer.unexpected();
    }
}

function parseExportDefault() {
    lexer.next();

    const start = lexer.start;
    const commentStart = lexer.commentStart;

    if (lexer.type === AT) {
        parseDecorators();
        parseDecoratedClass(start, commentStart);
        return;
    }

    if (lexer.type === NAME && lexer.word !== 0 && parseWordStatement(start, commentStart)) {
        return;
    }

    parseSlot(NONE, NONE, 0);
    consumeSemicolon();
}

function isTypeOnlyExportList() {
    if (!lexer.typescript || !isWord(KW_TYPE)) {
        return false;
    }

    lexer.peek();

    return lexer.peekType === BRACE_L || lexer.peekType === STAR;
}

// export { ... } from, export * from, export * as name from
function skipExportList() {
    if (isWord(KW_TYPE)) {
        lexer.next();
    }

    if (lexer.type === BRACE_L) {
        skipBalanced();
    } else {
        lexer.next();

        if (isWord(KW_AS)) {
            lexer.next();
            lexer.next();
        }
    }

    skipModuleSource();
}

// export = value, export as namespace Name, export import A = B
function parseTypeScriptExport() {
    if (lexer.type === ASSIGN) {
        lexer.next();
        parseSlot(NONE, NONE, 0);
        consumeSemicolon();
        return true;
    }

    if (isWord(KW_AS)) {
        lexer.next();
        lexer.next();
        lexer.next();
        consumeSemicolon();
        return true;
    }

    if (isWord(KW_IMPORT)) {
        parseImport();
        return true;
    }

    return false;
}

function parseImport() {
    lexer.next();

    if (lexer.typescript && parseImportEquals()) {
        return;
    }

    // bindings up to the source
    while (lexer.type !== STRING) {
        if (lexer.type === EOF) {
            lexer.unexpected();
        }

        if (lexer.type === BRACE_L) {
            skipBalanced();
        } else {
            lexer.nextAfterOperand();
        }
    }

    lexer.nextAfterOperand();
    skipModuleSource();
}

// import x = require('x'), import type x = A.B
function parseImportEquals() {
    if (isWord(KW_TYPE)) {
        lexer.peek();

        if (lexer.peekType === NAME) {
            lexer.next();
        }
    }

    if (lexer.type !== NAME) {
        return false;
    }

    lexer.peek();

    if (lexer.peekType !== ASSIGN) {
        return false;
    }

    lexer.next();
    lexer.next();
    parseSlot(NONE, NONE, 0);
    consumeSemicolon();
    return true;
}

// The source of an import or an export and its attributes, up to the end of the statement
function skipModuleSource() {
    if (isWord(KW_FROM)) {
        lexer.next();
        expect(STRING);
        lexer.nextAfterOperand();
    }

    if ((isWord(KW_WITH) || isWord(KW_ASSERT)) && !lexer.newlineBefore) {
        lexer.next();
        skipBalanced();
    }

    consumeSemicolon();
}

//
// TypeScript declarations
//

// A TypeScript declaration, false when its word starts an expression statement
function parseTypeScriptStatement(start: number, commentStart: number) {
    switch (lexer.word) {
        case KW_TYPE:
            if (!declarationFollows()) {
                return false;
            }

            lexer.next();
            lexer.nextAfterOperand();

            if (lexer.type === LT) {
                skipAngles();
            }

            expect(ASSIGN);
            lexer.nextAfterOperand();
            skipType();
            consumeSemicolon();
            return true;

        case KW_INTERFACE:
            if (!declarationFollows()) {
                return false;
            }

            skipInterface();
            return true;

        case KW_ENUM:
            if (!declarationFollows()) {
                return false;
            }

            parseEnum(start, commentStart);
            return true;

        case KW_ABSTRACT:
            lexer.peek();

            if (lexer.peekWord !== KW_CLASS || lexer.peekNewlineBefore) {
                return false;
            }

            lexer.next();
            parseClass(CLASS_DECLARATION, start, commentStart);
            return true;

        case KW_NAMESPACE:
        case KW_MODULE:
        case KW_GLOBAL:
            if (!isModuleDeclaration()) {
                return false;
            }

            skipModuleName();

            if (lexer.type === BRACE_L) {
                parseBody();
                lexer.next();
            } else {
                consumeSemicolon();
            }
            return true;

        case KW_DECLARE:
            if (!declarationFollows()) {
                return false;
            }

            // an ambient declaration starts at `declare`
            lexer.next();

            if (lexer.type !== NAME || !parseWordStatement(start, commentStart)) {
                lexer.unexpected();
            }
            return true;
    }

    return false;
}

// namespace A.B {}, module "name" {}, global {}
function isModuleDeclaration() {
    const word = lexer.word;

    lexer.peek();

    if (lexer.peekNewlineBefore) {
        return false;
    }

    return (
        lexer.peekType === NAME ||
        lexer.peekType === STRING ||
        (word === KW_GLOBAL && lexer.peekType === BRACE_L)
    );
}

function skipModuleName() {
    lexer.next();

    while (lexer.type === NAME || lexer.type === STRING || lexer.type === DOT) {
        lexer.nextAfterOperand();
    }
}

function skipInterface() {
    // the name after `interface`
    lexer.next();
    lexer.nextAfterOperand();

    // type parameters and heritage up to the body
    while (lexer.type !== BRACE_L) {
        if (lexer.type === EOF) {
            lexer.unexpected();
        }

        if (lexer.type === LT) {
            skipAngles();
        } else {
            lexer.nextAfterOperand();
        }
    }

    skipBalanced();
}

function skipDefiniteAndType() {
    if (lexer.type === BANG) {
        lexer.nextAfterOperand();
    }

    if (lexer.type === COLON) {
        lexer.nextAfterOperand();
        skipType();
    }
}

// An enum from `enum`, its start may be at `const`, `declare` or `export`
function parseEnum(start: number, commentStart: number) {
    lexer.next();
    expect(NAME);

    const name = nameAt(lexer.start, lexer.end);

    lexer.next();
    expect(BRACE_L);
    lexer.next();

    while (lexer.type !== BRACE_R) {
        const memberStart = nameStartAt();
        const memberEnd = lexer.end;

        lexer.nextAfterOperand();

        if (lexer.type === ASSIGN) {
            lexer.next();
            parseSlot(memberStart, memberEnd, 0);
        }

        nextListItem(BRACE_R);
    }

    const end = lexer.end;

    lexer.next();
    addRange(TS_ENUM_DECLARATION, leadingStart(start, commentStart), start, end, name, false);
}

//
// Functions and classes
//

// A function from `function`, its start may be at `async`, `declare` or `export`. A declaration without a body
// is a TypeScript overload or an ambient function, it starts its call frame at its start
function parseFunction(declaration: boolean, start: number, commentStart: number) {
    let name: string | null = null;

    lexer.next();

    if (lexer.type === STAR) {
        lexer.next();
    }

    if (lexer.type === NAME) {
        name = nameAt(lexer.start, lexer.end);
        lexer.next();
    }

    if (lexer.typescript && lexer.type === LT) {
        skipAngles();
    }

    expect(PAREN_L);

    const callFrameStart = lexer.start;

    parseParams();
    skipReturnType();

    if (lexer.type === BRACE_L) {
        const type = declaration
            ? FUNCTION_DECLARATION
            : FUNCTION_EXPRESSION;
        const end = parseFunctionBody(declaration);

        return addRange(type, leadingStart(start, commentStart), callFrameStart, end, name, false);
    }

    if (!lexer.typescript || !declaration) {
        lexer.unexpected();
    }

    // its own semicolon ends the declaration
    let end = lexer.previousEnd;

    if (lexer.type === SEMICOLON) {
        end = lexer.end;
        lexer.next();
    }

    return addRange(TS_DECLARE_FUNCTION, leadingStart(start, commentStart), start, end, name, false);
}

// A function body from its opening brace; returns its end
function parseFunctionBody(declaration: boolean) {
    parseBody();

    return closeBody(declaration);
}

// Reads the token after a closing brace of a function or a class body, returns the end of the body.
// An expression may continue after a function or a class expression, a statement starts after a declaration
function closeBody(declaration: boolean) {
    const end = lexer.end;

    if (declaration) {
        lexer.next();
    } else {
        lexer.nextAfterOperand();
    }

    return end;
}

// Parameters from their opening parenthesis
function parseParams() {
    lexer.next();

    while (lexer.type !== PAREN_R) {
        parseParameter();

        nextListItem(PAREN_R);
    }

    lexer.next();
}

// A parameter, or an element of parentheses that may turn out to be a parameter of an arrow function;
// its decorators, modifiers and type of TypeScript are skipped. Returns a function taking the whole element
function parseParameter() {
    if (lexer.type === AT) {
        parseDecorators();
    }

    if (lexer.typescript) {
        skipParameterModifiers();
    }

    const nameStart = lexer.type === NAME
        ? lexer.start
        : NONE;
    const nameEnd = lexer.end;
    const element = parseAssignment(MAYBE_PARAMS);

    if (!lexer.typescript || lexer.type !== COLON) {
        return element;
    }

    // a default value after a type, it's named by a parameter of a lone name
    const named = nameStart !== NONE && lexer.previousEnd === nameEnd;

    lexer.nextAfterOperand();
    skipType();

    if (lexer.type === ASSIGN) {
        lexer.next();

        if (named) {
            parseSlot(nameStart, nameEnd, 0);
        } else {
            parseSlot(NONE, NONE, 0);
        }
    }

    return NONE;
}

// public, private, protected, readonly and override of parameter properties
function skipParameterModifiers() {
    while (
        isWord(KW_PUBLIC) ||
        isWord(KW_PRIVATE) ||
        isWord(KW_PROTECTED) ||
        isWord(KW_READONLY) ||
        isWord(KW_OVERRIDE)
    ) {
        lexer.peek();

        if (lexer.peekType !== NAME && lexer.peekType !== BRACE_L && lexer.peekType !== BRACKET_L) {
            return;
        }

        lexer.next();
    }
}

function skipReturnType() {
    if (lexer.typescript && lexer.type === COLON) {
        lexer.nextAfterOperand();
        skipType();
    }
}

// An arrow function from its `=>`, the start is at its parameters
function parseArrowFunction(start: number, flags: number) {
    lexer.next();

    if (lexer.type === BRACE_L) {
        parseBody();

        const end = lexer.end;

        // an arrow function can't be an operand of an operator
        lexer.next();

        return addRange(ARROW_FUNCTION, start, start, end, null, false);
    }

    parseSlot(NONE, NONE, flags & FOR_INIT);

    return addRange(ARROW_FUNCTION, start, start, lexer.previousEnd, null, false);
}

// Whether a range is an arrow function starting at an offset, i.e. not parenthesized
function isArrowFunctionAt(range: number, start: number) {
    return (
        range !== NONE &&
        ranges.type[range] === ARROW_FUNCTION &&
        ranges.callFrameStart[range] === start
    );
}

// A class from `class`, its start may be at its decorators, `abstract`, `declare` or `export`
function parseClass(type: number, start: number, commentStart: number) {
    let name: string | null = null;

    lexer.next();

    if (lexer.type === NAME && lexer.word !== KW_EXTENDS && lexer.word !== KW_IMPLEMENTS) {
        name = nameAt(lexer.start, lexer.end);
        lexer.next();
    }

    if (lexer.typescript && lexer.type === LT) {
        skipAngles();
    }

    if (isWord(KW_EXTENDS)) {
        lexer.next();

        const heritageCommentStart = lexer.commentStart;

        takeSlot(parseOperand(HERITAGE), heritageCommentStart, NONE, NONE);
    }

    if (lexer.typescript && isWord(KW_IMPLEMENTS)) {
        skipImplements();
    }

    expect(BRACE_L);

    const hasConstructor = parseClassBody();
    const end = closeBody(type === CLASS_DECLARATION);

    return addRange(type, leadingStart(start, commentStart), start, end, name, !hasConstructor);
}

function skipImplements() {
    while (lexer.type !== BRACE_L) {
        if (lexer.type === EOF) {
            lexer.unexpected();
        }

        if (lexer.type === LT) {
            skipAngles();
        } else {
            lexer.nextAfterOperand();
        }
    }
}

// Members of a class body from its opening brace, the current token is its closing brace then;
// returns whether the class has a constructor of its own
function parseClassBody() {
    let hasConstructor = false;

    lexer.next();

    while (lexer.type !== BRACE_R) {
        if (lexer.type === SEMICOLON) {
            lexer.next();
        } else if (lexer.type === EOF) {
            lexer.unexpected();
        } else if (parseClassMember()) {
            hasConstructor = true;
        }
    }

    return hasConstructor;
}

// A member of a class body; returns whether it's the class's constructor
function parseClassMember() {
    const start = lexer.start;
    const commentStart = lexer.commentStart;
    let isStatic = false;

    if (lexer.type === AT) {
        parseDecorators();
    }

    while (lexer.type === NAME && classModifiers[lexer.word] === 1 && modifierPrecedesKey()) {
        if (lexer.word === KW_STATIC) {
            isStatic = true;
        }

        lexer.next();
    }

    // a static block
    if (isStatic && lexer.type === BRACE_L) {
        parseBody();
        lexer.next();
        return false;
    }

    if (lexer.type === STAR) {
        lexer.next();
    }

    const keyType = lexer.type;
    const nameStart = nameStartAt();
    const nameEnd = lexer.end;
    const isConstructor = !isStatic && isConstructorKey();

    parsePropertyKey();

    if (lexer.typescript) {
        skipOptionalAndTypeParameters();
    }

    if (lexer.type === PAREN_L) {
        const type = keyType === PRIVATE_NAME
            ? CLASS_PRIVATE_METHOD
            : CLASS_METHOD;

        // an overload or an abstract method has no function
        if (parseMethod(type, start, commentStart, nameStart, nameEnd) === NONE) {
            consumeSemicolon();
        }

        return isConstructor;
    }

    // a property
    if (lexer.typescript) {
        skipDefiniteAndType();
    }

    if (lexer.type === ASSIGN) {
        lexer.next();
        parseSlot(nameStart, nameEnd, 0);
    }

    consumeSemicolon();
    return false;
}

function isConstructorKey() {
    if (lexer.type === NAME) {
        return lexer.word === KW_CONSTRUCTOR;
    }

    return (
        lexer.type === STRING &&
        lexer.end - lexer.start === 13 &&
        lexer.source.startsWith('constructor', lexer.start + 1)
    );
}

// The ? of an optional method and type parameters of TypeScript after a member's key
function skipOptionalAndTypeParameters() {
    if (lexer.type === QUESTION || lexer.type === BANG) {
        lexer.nextAfterOperand();
    }

    if (lexer.type === LT) {
        skipAngles();
    }
}

// Whether a modifier of a member is followed by the member's key, otherwise the modifier is the key
function modifierPrecedesKey() {
    const word = lexer.word;

    lexer.peek();

    if (word === KW_ASYNC && lexer.peekNewlineBefore) {
        return false;
    }

    switch (lexer.peekType) {
        case NAME:
        case STRING:
        case NUMBER:
        case BRACKET_L:
        case PRIVATE_NAME:
            return true;

        case STAR:
            return word !== KW_GET && word !== KW_SET;

        case BRACE_L:
            return word === KW_STATIC;
    }

    return false;
}

// A method from its parameters; returns NONE for a method without a body
function parseMethod(type: number, start: number, commentStart: number, nameStart: number, nameEnd: number) {
    const callFrameStart = lexer.start;

    parseParams();
    skipReturnType();

    if (lexer.type !== BRACE_L) {
        return NONE;
    }

    const name = nameStart !== NONE
        ? nameAt(nameStart, nameEnd)
        : '';
    const end = parseFunctionBody(true);

    return addRange(type, leadingStart(start, commentStart), callFrameStart, end, name, false);
}

// A property key: a name, a string, a number or a computed key
function parsePropertyKey() {
    switch (lexer.type) {
        case NAME:
        case PRIVATE_NAME:
        case STRING:
        case NUMBER:
            lexer.nextAfterOperand();
            return;

        case BRACKET_L:
            lexer.next();
            parseSlot(NONE, NONE, 0);

            // an index signature of a class
            if (lexer.typescript && lexer.type === COLON) {
                lexer.nextAfterOperand();
                skipType();
            }

            expect(BRACKET_R);
            lexer.nextAfterOperand();
            return;
    }

    lexer.unexpected();
}

function parseDecorators() {
    while (lexer.type === AT) {
        lexer.next();

        if (lexer.type === PAREN_L) {
            lexer.next();
            parseSlotSequence(0);
            expect(PAREN_R);
        } else {
            expect(NAME);
        }

        lexer.nextAfterOperand();
        skipDecoratorTail();
    }
}

// Member accesses, calls and type arguments of a decorator
function skipDecoratorTail() {
    while (true) {
        if (lexer.type === DOT) {
            lexer.next();
            lexer.nextAfterOperand();
        } else if (lexer.type === PAREN_L) {
            parseArguments();
        } else if (lexer.typescript && lexer.type === LT) {
            skipAngles();
        } else {
            return;
        }
    }
}

// A class after its decorators, possibly exported. An exported class starts at its decorators,
// without the comments before them
function parseDecoratedClass(start: number, commentStart: number) {
    const exported = isWord(KW_EXPORT);

    if (exported) {
        lexer.next();

        if (isWord(KW_DEFAULT)) {
            lexer.next();
        }
    }

    if (isWord(KW_ABSTRACT)) {
        lexer.next();
    }

    if (!isWord(KW_CLASS)) {
        lexer.unexpected();
    }

    if (exported) {
        parseClass(CLASS_DECLARATION, start, NONE);
    } else {
        parseClass(CLASS_DECLARATION, start, commentStart);
    }
}

//
// Expressions
//

// An expression of a slot of its own; a function taking the whole of it gets the comments before it
// and the slot's name
function parseSlot(nameStart: number, nameEnd: number, flags: number) {
    const commentStart = lexer.commentStart;

    takeSlot(parseAssignment(flags), commentStart, nameStart, nameEnd);
}

function parseSlotSequence(flags: number) {
    const commentStart = lexer.commentStart;

    takeSlot(parseSequence(flags), commentStart, NONE, NONE);
}

// Expressions separated by commas. A sequence starts with its first expression, so the comments before it
// belong to the sequence; returns a function taking the whole sequence, NONE otherwise
function parseSequence(flags: number) {
    const first = parseAssignment(flags);

    if (lexer.type !== COMMA) {
        return first;
    }

    while (lexer.type === COMMA) {
        lexer.next();
        parseSlot(NONE, NONE, flags);
    }

    return NONE;
}

// Returns a function taking the whole expression, NONE otherwise
function parseAssignment(flags: number) {
    const targetStart = lexer.type === NAME
        ? lexer.start
        : NONE;
    const targetEnd = lexer.end;
    const value = parseConditional(flags);

    if (lexer.type !== ASSIGN && lexer.type !== OPERATOR_ASSIGN) {
        return value;
    }

    // a lone identifier as the target names an assigned function
    const named = targetStart !== NONE && lexer.previousEnd === targetEnd;
    const valueFlags = flags & FOR_INIT;

    lexer.next();

    if (named) {
        parseSlot(targetStart, targetEnd, valueFlags);
    } else {
        parseSlot(NONE, NONE, valueFlags);
    }

    return NONE;
}

function parseConditional(flags: number) {
    const test = parseBinary(0, flags & FOR_INIT);

    if (lexer.type !== QUESTION) {
        return test;
    }

    // the ? of an optional parameter
    if ((flags & MAYBE_PARAMS) !== 0 && isOptionalParameterMark()) {
        lexer.nextAfterOperand();
        return NONE;
    }

    lexer.next();
    parseSlot(NONE, NONE, 0);
    expect(COLON);
    lexer.next();
    parseSlot(NONE, NONE, flags & FOR_INIT);

    return NONE;
}

// A ? followed by the type, the end or the default value of a parameter
function isOptionalParameterMark() {
    if (!lexer.typescript) {
        return false;
    }

    lexer.peek();

    switch (lexer.peekType) {
        case COLON:
        case COMMA:
        case PAREN_R:
        case ASSIGN:
            return true;
    }

    return false;
}

// Binary operators of a higher precedence than a given one with their operands; an operand is a slot
// unless it's the left one, which starts its operator's expression
function parseBinary(minPrec: number, flags: number) {
    let left = parseUnary(flags);

    while (true) {
        const prec = binaryPrecedence(flags);

        if (prec <= minPrec) {
            return left;
        }

        left = NONE;

        if (lexer.word === KW_AS || lexer.word === KW_SATISFIES) {
            lexer.nextAfterOperand();
            skipType();
            continue;
        }

        // ** is right-associative
        const operandPrec = prec === PREC_EXPONENT
            ? prec - 1
            : prec;

        lexer.next();

        const commentStart = lexer.commentStart;

        takeSlot(parseBinary(operandPrec, flags), commentStart, NONE, NONE);
    }
}

function binaryPrecedence(flags: number) {
    if (lexer.type !== NAME) {
        return lexer.prec;
    }

    if (lexer.word === KW_IN && (flags & FOR_INIT) !== 0) {
        return 0;
    }

    // `as` and `satisfies` after a line break start a new statement
    if ((lexer.word === KW_AS || lexer.word === KW_SATISFIES) && lexer.newlineBefore) {
        return 0;
    }

    return lexer.prec;
}

// Prefix operators and their operand, an operand is a slot
function parseUnary(flags: number): number {
    if (!parsePrefixOperator()) {
        return parseOperand(flags);
    }

    const commentStart = lexer.commentStart;

    takeSlot(parseUnary(flags), commentStart, NONE, NONE);

    return NONE;
}

// Reads a prefix operator; false when the token isn't one
function parsePrefixOperator() {
    switch (lexer.type) {
        case BANG:
        case TILDE:
        case PLUS_MINUS:
        case INC_DEC:
        case ELLIPSIS:
            lexer.next();
            return true;

        case NAME:
            switch (lexer.word) {
                case KW_TYPEOF:
                case KW_VOID:
                case KW_DELETE:
                    lexer.next();
                    return true;

                case KW_NEW:
                    lexer.peek();

                    // new.target
                    if (lexer.peekType === DOT) {
                        return false;
                    }

                    lexer.next();
                    return true;

                case KW_AWAIT:
                case KW_YIELD:
                    return parseAwaitOrYield();
            }
    }

    return false;
}

// `await` and `yield` are operators when an operand follows them, identifiers otherwise;
// an operand of `yield` is on its line
function parseAwaitOrYield() {
    const isYield = lexer.word === KW_YIELD;

    lexer.peek();

    if (isYield && lexer.peekType === STAR) {
        lexer.next();
        lexer.next();
        return true;
    }

    if (startsExpression[lexer.peekType] === 0 || (isYield && lexer.peekNewlineBefore)) {
        return false;
    }

    lexer.next();
    return true;
}

// An operand with its member accesses, calls and postfix operators; an arrow function can't have any of them
function parseOperand(flags: number) {
    const start = lexer.start;
    const operand = parsePrimary(flags);

    return isArrowFunctionAt(operand, start)
        ? operand
        : parseChain(operand, flags);
}

// Returns a function or a class, NONE for other operands
function parsePrimary(flags: number): number {
    const start = lexer.start;

    switch (lexer.type) {
        case NAME:
            return parseNameOperand(flags);

        case NUMBER:
        case STRING:
        case REGEXP:
        case PRIVATE_NAME:
            lexer.nextAfterOperand();
            return NONE;

        case TEMPLATE:
        case TEMPLATE_HEAD:
            parseTemplate();
            return NONE;

        case PAREN_L:
            return parseParenthesized(start, flags, false);

        case BRACKET_L:
            parseArrayLiteral();
            return NONE;

        case BRACE_L:
            parseObjectLiteral();
            return NONE;

        case AT:
            parseDecorators();

            if (!isWord(KW_CLASS)) {
                lexer.unexpected();
            }

            return parseClass(CLASS_EXPRESSION, start, NONE);

        case LT:
            return parseAngleOperand(start, flags);
    }

    return lexer.unexpected();
}

function parseNameOperand(flags: number) {
    const start = lexer.start;

    switch (lexer.word) {
        case KW_FUNCTION:
            return parseFunction(false, start, NONE);

        case KW_CLASS:
            return parseClass(CLASS_EXPRESSION, start, NONE);

        case KW_ASYNC:
            return parseAsync(flags);
    }

    return parseIdentifier(flags);
}

// An identifier, or a parameter of an arrow function
function parseIdentifier(flags: number) {
    const start = lexer.start;

    lexer.nextAfterOperand();

    if (lexer.type === ARROW && !lexer.newlineBefore) {
        return parseArrowFunction(start, flags);
    }

    return NONE;
}

// An operand from `async`: an async function or arrow function, a call of `async`, or the identifier
function parseAsync(flags: number) {
    const start = lexer.start;

    lexer.peek();

    if (!lexer.peekNewlineBefore) {
        switch (lexer.peekType) {
            case NAME:
                if (lexer.peekWord === KW_FUNCTION) {
                    lexer.next();
                    return parseFunction(false, start, NONE);
                }

                // async x => x
                lexer.next();
                lexer.nextAfterOperand();
                expect(ARROW);
                return parseArrowFunction(start, flags);

            case PAREN_L:
                lexer.next();
                return parseParenthesized(start, flags, true);

            case LT:
                if (lexer.typescript) {
                    lexer.next();
                    skipAngles();
                    expect(PAREN_L);
                    return parseParenthesized(start, flags, true);
                }
                break;
        }
    }

    return parseIdentifier(flags);
}

// Parentheses from the opening one: arrow function parameters, a parenthesized expression or arguments
// of an `async` call. Parentheses have no node of their own, so a function taking the whole of them takes
// their slot, and an argument of a call is a slot of its own
function parseParenthesized(start: number, flags: number, asyncCall: boolean) {
    let first = NONE;
    let firstCommentStart = NONE;
    let count = 0;

    lexer.next();

    while (lexer.type !== PAREN_R) {
        const commentStart = lexer.commentStart;
        const element = parseParameter();

        if (count === 0) {
            first = element;
            firstCommentStart = commentStart;
        } else {
            takeSlot(element, commentStart, NONE, NONE);
        }

        count++;

        nextListItem(PAREN_R);
    }

    lexer.nextAfterOperand();

    if (lexer.type === ARROW && !lexer.newlineBefore) {
        return parseArrowFunction(start, flags);
    }

    if (lexer.typescript && lexer.type === COLON && skipArrowReturnType()) {
        return parseArrowFunction(start, flags);
    }

    // an argument of a call
    if (asyncCall) {
        takeSlot(first, firstCommentStart, NONE, NONE);
        return NONE;
    }

    // a sequence starts with its first expression, which takes no slot
    if (count !== 1) {
        return NONE;
    }

    takeSlot(first, firstCommentStart, NONE, NONE);

    return first;
}

// `<` as an operand: a JSX element, or in TypeScript an arrow function with type parameters or a type assertion
function parseAngleOperand(start: number, flags: number) {
    if (jsx && !isTypeParametersInJsx()) {
        parseJsxElement();
        return NONE;
    }

    if (!lexer.typescript) {
        lexer.unexpected();
    }

    skipAngles();

    if (lexer.type !== PAREN_L) {
        // a type assertion
        parseUnary(flags);
        return NONE;
    }

    const operand = parseParenthesized(start, flags, false);

    return isArrowFunctionAt(operand, start)
        ? operand
        : NONE;
}

// In TSX, <T,> and <T extends U> start type parameters of an arrow function, <T> starts an element
function isTypeParametersInJsx() {
    if (!lexer.typescript) {
        return false;
    }

    const state = lexer.save();
    let typeParameters = false;

    lexer.nextAfterOperand();

    if (isWord(KW_CONST)) {
        lexer.nextAfterOperand();
    }

    if (lexer.type === NAME) {
        lexer.nextAfterOperand();
        typeParameters = lexer.type === COMMA || isWord(KW_EXTENDS);
    }

    lexer.restore(state);

    return typeParameters;
}

// Member accesses, calls, tagged templates and postfix operators after an operand; a function or a class
// followed by any of them isn't the whole of its slot. Returns the given operand when there are none, NONE otherwise
function parseChain(operand: number, flags: number) {
    while (true) {
        switch (lexer.type) {
            case DOT:
            case QUESTION_DOT:
                lexer.next();
                parseChainAfterDot();
                break;

            case PAREN_L:
                parseArguments();
                break;

            case BRACKET_L:
                parseComputedMember();
                break;

            case TEMPLATE:
            case TEMPLATE_HEAD:
                parseTemplate();
                break;

            case INC_DEC:
                if (lexer.newlineBefore) {
                    return operand;
                }

                lexer.nextAfterOperand();
                break;

            case BANG:
                // a non-null assertion
                if (!lexer.typescript || lexer.newlineBefore) {
                    return operand;
                }

                lexer.nextAfterOperand();
                break;

            case LT:
                if (!lexer.typescript) {
                    return operand;
                }

                // type arguments of a superclass, a comparison can't follow it
                if ((flags & HERITAGE) !== 0) {
                    skipAngles();
                } else if (!tryTypeArguments()) {
                    return operand;
                }
                break;

            default:
                return operand;
        }

        operand = NONE;
    }
}

// A member name, or a call, a computed member or type arguments after ?.
function parseChainAfterDot() {
    switch (lexer.type) {
        case PAREN_L:
            parseArguments();
            return;

        case BRACKET_L:
            parseComputedMember();
            return;

        case LT:
            if (lexer.typescript) {
                skipAngles();
                return;
            }
            break;

        case NAME:
        case PRIVATE_NAME:
            lexer.nextAfterOperand();
            return;
    }

    lexer.unexpected();
}

function parseComputedMember() {
    lexer.next();
    parseSlotSequence(0);
    expect(BRACKET_R);
    lexer.nextAfterOperand();
}

function parseArguments() {
    lexer.next();

    while (lexer.type !== PAREN_R) {
        parseSlot(NONE, NONE, 0);

        nextListItem(PAREN_R);
    }

    lexer.nextAfterOperand();
}

function parseTemplate() {
    while (lexer.type === TEMPLATE_HEAD) {
        lexer.next();
        parseSlotSequence(0);
        expect(BRACE_R);
        lexer.continueTemplate();
    }

    lexer.nextAfterOperand();
}

function parseArrayLiteral() {
    lexer.next();

    while (lexer.type !== BRACKET_R) {
        // a hole otherwise
        if (lexer.type !== COMMA) {
            parseSlot(NONE, NONE, 0);
        }

        nextListItem(BRACKET_R);
    }

    lexer.nextAfterOperand();
}

// An object literal or an object pattern
function parseObjectLiteral() {
    lexer.next();

    while (lexer.type !== BRACE_R) {
        if (lexer.type === ELLIPSIS) {
            parseSlot(NONE, NONE, 0);
        } else {
            parseObjectMember();
        }

        nextListItem(BRACE_R);
    }

    lexer.nextAfterOperand();
}

function parseObjectMember() {
    const start = lexer.start;
    const commentStart = lexer.commentStart;

    while ((isWord(KW_ASYNC) || isWord(KW_GET) || isWord(KW_SET)) && modifierPrecedesKey()) {
        lexer.next();
    }

    if (lexer.type === STAR) {
        lexer.next();
    }

    const nameStart = nameStartAt();
    const nameEnd = lexer.end;

    parsePropertyKey();

    if (lexer.typescript && lexer.type === LT) {
        skipAngles();
    }

    if (lexer.type === PAREN_L) {
        parseMethod(OBJECT_METHOD, start, commentStart, nameStart, nameEnd);
        return;
    }

    // a value, or a default value of a shorthand property of a pattern
    if (lexer.type === COLON || lexer.type === ASSIGN) {
        lexer.next();
        parseSlot(nameStart, nameEnd, 0);
    }
}

//
// JSX
//

// A JSX element or fragment from its `<` token to the token after it
function parseJsxElement() {
    parseJsxTag();
    lexer.nextAfterOperand();
}

// An element from its `<` token, the lexer is right after the element then
function parseJsxTag() {
    lexer.nextJsxTag();

    // a fragment
    if (lexer.type === GT) {
        parseJsxChildren();
        return;
    }

    expect(NAME);
    lexer.nextJsxTag();

    if (lexer.typescript && lexer.type === LT) {
        skipAngles();
        lexer.rewind();
        lexer.nextJsxTag();
    }

    // attributes
    while (true) {
        switch (lexer.type) {
            case SLASH:
                lexer.nextJsxTag();
                expect(GT);
                return;

            case GT:
                parseJsxChildren();
                return;

            case BRACE_L:
                parseJsxExpressionContainer();
                break;

            case NAME:
                lexer.nextJsxTag();

                if (lexer.type === ASSIGN) {
                    lexer.nextJsxTag();
                    parseJsxAttributeValue();
                }
                continue;

            default:
                lexer.unexpected();
        }

        lexer.nextJsxTag();
    }
}

function parseJsxAttributeValue() {
    switch (lexer.type) {
        case STRING:
            break;

        case BRACE_L:
            parseJsxExpressionContainer();
            break;

        case LT:
            parseJsxTag();
            break;

        default:
            lexer.unexpected();
    }

    lexer.nextJsxTag();
}

// Children up to the closing tag, the lexer is right after it then
function parseJsxChildren() {
    while (true) {
        lexer.nextJsxChild();

        if (lexer.type === BRACE_L) {
            parseJsxExpressionContainer();
        } else if (lexer.atJsxClosingTag()) {
            lexer.skipJsxClosingTag();
            return;
        } else {
            parseJsxTag();
        }
    }
}

// An expression container from its `{` up to its `}`, the lexer is right after it then
function parseJsxExpressionContainer() {
    lexer.next();

    // empty, or a comment only
    if (lexer.type === BRACE_R) {
        return;
    }

    parseSlot(NONE, NONE, 0);
    expect(BRACE_R);
}

//
// TypeScript types are skipped
//

// Skips tokens from an opening bracket to the token after its closing one
function skipBalanced() {
    let depth = 0;

    while (true) {
        switch (lexer.type) {
            case PAREN_L:
            case BRACKET_L:
            case BRACE_L:
                depth++;
                break;

            case PAREN_R:
            case BRACKET_R:
            case BRACE_R:
                depth--;
                break;

            case TEMPLATE_HEAD:
                skipTemplateType();
                continue;

            case EOF:
                lexer.unexpected();
        }

        lexer.nextAfterOperand();

        if (depth === 0) {
            return;
        }
    }
}

// Skips a list in angle brackets from its `<` to the token after its `>`; a token starting with < or >,
// e.g. >> of nested lists, is split
function skipAngles() {
    let depth = 0;

    while (true) {
        const first = lexer.firstChar();

        if (first === 60 /* < */) {
            lexer.splitFirstChar(LT);
            depth++;
        } else if (first === 62 /* > */) {
            lexer.splitFirstChar(GT);
            depth--;
        } else {
            switch (lexer.type) {
                case PAREN_L:
                case BRACKET_L:
                case BRACE_L:
                    skipBalanced();
                    continue;

                case TEMPLATE_HEAD:
                    skipTemplateType();
                    continue;

                case EOF:
                case SEMICOLON:
                    lexer.unexpected();
            }
        }

        lexer.nextAfterOperand();

        if (depth === 0) {
            return;
        }
    }
}

// A template literal type, its substitutions are types
function skipTemplateType() {
    while (lexer.type === TEMPLATE_HEAD) {
        lexer.nextAfterOperand();
        skipType();
        expect(BRACE_R);
        lexer.continueTemplate();
    }

    lexer.nextAfterOperand();
}

// Type arguments after an operand, when a call, a template or the end of an expression follows them;
// otherwise `<` is a comparison and the lexer stays at it
function tryTypeArguments() {
    const state = lexer.save();

    try {
        if (skipTypeArguments()) {
            lexer.discardSaved(state);
            return true;
        }
    } catch {
        // not types
    }

    lexer.restore(state);

    return false;
}

function skipTypeArguments() {
    lexer.nextAfterOperand();

    while (true) {
        if (!skipType()) {
            return false;
        }

        if (lexer.type !== COMMA) {
            break;
        }

        lexer.nextAfterOperand();
    }

    if (lexer.firstChar() !== 62 /* > */) {
        return false;
    }

    lexer.splitFirstChar(GT);
    lexer.nextAfterOperand();

    switch (lexer.type) {
        case PAREN_L:
        case TEMPLATE:
        case TEMPLATE_HEAD:
            return true;
    }

    return lexer.newlineBefore || startsExpression[lexer.type] === 0;
}

// Whether a colon after parentheses starts a return type of an arrow function, which is skipped then;
// otherwise the lexer stays at the colon
function skipArrowReturnType() {
    const state = lexer.save();

    try {
        lexer.nextAfterOperand();

        if (skipType() && lexer.type === ARROW && !lexer.newlineBefore) {
            lexer.discardSaved(state);
            return true;
        }
    } catch {
        // not a type
    }

    lexer.restore(state);

    return false;
}

// Words that start a type of the type after them: keyof, unique and readonly operators, infer T, typeof x,
// import("x"), asserts x, and constructor types; each of them is a type name when no type follows it
const typePrefixes = new Uint8Array(KW_YIELD + 1);
const typePrefixWords = [
    KW_KEYOF,
    KW_UNIQUE,
    KW_READONLY,
    KW_INFER,
    KW_TYPEOF,
    KW_IMPORT,
    KW_ASSERTS,
    KW_ABSTRACT,
    KW_NEW
];

for (let i = 0; i < typePrefixWords.length; i++) {
    typePrefixes[typePrefixWords[i]] = 1;
}

// Tokens that can start a type
const startsType = new Uint8Array(SLASH + 1);
const typeStartTokens = [
    NAME,
    STRING,
    NUMBER,
    TEMPLATE,
    TEMPLATE_HEAD,
    PAREN_L,
    BRACKET_L,
    BRACE_L,
    LT,
    PLUS_MINUS,
    PIPE,
    AMPERSAND
];

for (let i = 0; i < typeStartTokens.length; i++) {
    startsType[typeStartTokens[i]] = 1;
}

// Skips a type up to the first token that can't continue it; false when the token can't start a type.
// A type is skipped as operands and the operators between them, its brackets as a whole: only the tokens
// that continue a type matter, not its structure
function skipType() {
    let operand = false; // the last skipped token ends an operand, a type may end after it
    let parameters = false; // the operand is parameters of a function type, `=>` follows them
    let functionType = false; // type parameters or `new` before parentheses make them parameters
    let extendsCount = 0; // `extends` of conditional types waiting for their `?`
    let conditionals = 0; // `?` of conditional types waiting for their `:`

    while (true) {
        if (!operand) {
            switch (lexer.type) {
                case NAME:
                    if (typePrefixes[lexer.word] === 1) {
                        functionType = lexer.word === KW_NEW;
                        lexer.nextAfterOperand();
                        // a prefix word without a type after it is a name
                        operand = startsType[lexer.type] === 0;
                        continue;
                    }

                    lexer.nextAfterOperand();
                    break;

                case PAREN_L:
                    parameters = skipTypeParentheses() || functionType;
                    functionType = false;
                    operand = true;
                    continue;

                case BRACKET_L:
                case BRACE_L:
                    skipBalanced();
                    break;

                case TEMPLATE:
                case TEMPLATE_HEAD:
                    skipTemplateType();
                    break;

                case STRING:
                case NUMBER:
                    lexer.nextAfterOperand();
                    break;

                // type parameters of a generic function type
                case LT:
                    skipAngles();
                    functionType = true;
                    continue;

                // a negative number, a leading | or &
                case PLUS_MINUS:
                case PIPE:
                case AMPERSAND:
                    lexer.nextAfterOperand();
                    continue;

                default:
                    return false;
            }

            operand = true;
            parameters = false;
            continue;
        }

        switch (lexer.type) {
            // a qualified name
            case DOT:
                lexer.nextAfterOperand();
                lexer.nextAfterOperand();
                continue;

            // type arguments, and array and indexed access types
            case LT:
            case BRACKET_L:
                if (lexer.newlineBefore) {
                    return true;
                }

                if (lexer.type === LT) {
                    skipAngles();
                } else {
                    skipBalanced();
                }

                parameters = false;
                continue;

            case ARROW:
                if (!parameters) {
                    return true;
                }
                break;

            case PIPE:
            case AMPERSAND:
                break;

            case QUESTION:
                if (extendsCount === 0) {
                    return true;
                }

                extendsCount--;
                conditionals++;
                break;

            case COLON:
                if (conditionals === 0) {
                    return true;
                }

                conditionals--;
                break;

            // a conditional type, and a type predicate
            case NAME:
                if (lexer.newlineBefore || (lexer.word !== KW_EXTENDS && lexer.word !== KW_IS)) {
                    return true;
                }

                if (lexer.word === KW_EXTENDS) {
                    extendsCount++;
                }
                break;

            default:
                return true;
        }

        lexer.nextAfterOperand();
        operand = false;
        parameters = false;
    }
}

// Skips parentheses of a type; returns whether they are parameters of a function type: they are empty,
// start with a rest parameter, a parameter followed by its type, a separator or a default value,
// or have a single parameter with `=>` after them
function skipTypeParentheses() {
    let parameters = false;
    let single = false;

    lexer.nextAfterOperand();

    switch (lexer.type) {
        case PAREN_R:
        case ELLIPSIS:
            parameters = true;
            break;

        case NAME:
        case BRACE_L:
        case BRACKET_L:
            if (lexer.type === NAME) {
                lexer.nextAfterOperand();
            } else {
                skipBalanced();
            }

            parameters = (
                lexer.type === COLON ||
                lexer.type === COMMA ||
                lexer.type === QUESTION ||
                lexer.type === ASSIGN
            );
            single = lexer.type === PAREN_R;
            break;
    }

    // the rest of the parentheses
    while (lexer.type !== PAREN_R) {
        switch (lexer.type) {
            case PAREN_L:
            case BRACKET_L:
            case BRACE_L:
                skipBalanced();
                continue;

            case TEMPLATE_HEAD:
                skipTemplateType();
                continue;

            case EOF:
                lexer.unexpected();
        }

        lexer.nextAfterOperand();
    }

    lexer.nextAfterOperand();

    return parameters || (single && lexer.type === ARROW);
}
