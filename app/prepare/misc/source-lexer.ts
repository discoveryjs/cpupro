import { isIdentifierChar, isIdentifierStart } from '@babel/helper-validator-identifier';

// Tokens of JavaScript, TypeScript and JSX sources, as far as boundaries of functions depend on them: a token is
// its type, its offsets and a few attributes; numbers, strings and regular expressions are skipped, not decoded.
// Whether a slash starts a regular expression or is a division depends on the grammar, so the grammar tells
// the lexer which of them may come next

export const NONE: number = -1;

// Token types
export const EOF: number = 0;
export const NAME: number = 1; // identifiers, keywords and contextual words
export const PRIVATE_NAME: number = 2; // #name
export const NUMBER: number = 3;
export const STRING: number = 4;
export const TEMPLATE: number = 5; // a template without substitutions, or its tail after the last substitution
export const TEMPLATE_HEAD: number = 6; // a template or its middle up to a substitution, "${" included
export const REGEXP: number = 7;
export const PAREN_L: number = 8;
export const PAREN_R: number = 9;
export const BRACKET_L: number = 10;
export const BRACKET_R: number = 11;
export const BRACE_L: number = 12;
export const BRACE_R: number = 13;
export const SEMICOLON: number = 14;
export const COMMA: number = 15;
export const COLON: number = 16;
export const DOT: number = 17;
export const QUESTION_DOT: number = 18;
export const ELLIPSIS: number = 19;
export const ARROW: number = 20;
export const QUESTION: number = 21;
export const AT: number = 22;
export const ASSIGN: number = 23; // =
export const OPERATOR_ASSIGN: number = 24; // += -= ||= ??= >>>= and so on
export const LT: number = 25; // a single <, it opens type parameters and JSX elements too
export const GT: number = 26; // a single >, it closes type parameters too
export const STAR: number = 27;
export const PLUS_MINUS: number = 28;
export const PIPE: number = 29; // a single |, a union type too
export const AMPERSAND: number = 30; // a single &, an intersection type too
export const BINARY: number = 31; // the other binary operators
export const INC_DEC: number = 32;
export const BANG: number = 33;
export const TILDE: number = 34;
export const SLASH: number = 35; // a slash of a JSX tag

// Precedences of binary operators, a higher one binds tighter; 0 for tokens that aren't binary operators
export const PREC_RELATIONAL: number = 7;
export const PREC_EXPONENT: number = 11;

// Words the grammar recognizes, a word is identified by its index in the list plus one, other names by 0
const words = [
    'abstract', 'accessor', 'as', 'assert', 'asserts', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
    'constructor', 'continue', 'debugger', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export',
    'extends', 'finally', 'for', 'from', 'function', 'get', 'global', 'if', 'implements', 'import', 'in', 'infer',
    'instanceof', 'interface', 'is', 'keyof', 'let', 'module', 'namespace', 'new', 'of', 'override', 'private',
    'protected', 'public', 'readonly', 'return', 'satisfies', 'set', 'static', 'switch', 'throw', 'try', 'type',
    'typeof', 'unique', 'using', 'var', 'void', 'while', 'with', 'yield'
];

function wordId(word: string) {
    return words.indexOf(word) + 1;
}

export const KW_ABSTRACT = wordId('abstract');
export const KW_ACCESSOR = wordId('accessor');
export const KW_AS = wordId('as');
export const KW_ASSERT = wordId('assert');
export const KW_ASSERTS = wordId('asserts');
export const KW_ASYNC = wordId('async');
export const KW_AWAIT = wordId('await');
export const KW_BREAK = wordId('break');
export const KW_CASE = wordId('case');
export const KW_CATCH = wordId('catch');
export const KW_CLASS = wordId('class');
export const KW_CONST = wordId('const');
export const KW_CONSTRUCTOR = wordId('constructor');
export const KW_CONTINUE = wordId('continue');
export const KW_DEBUGGER = wordId('debugger');
export const KW_DECLARE = wordId('declare');
export const KW_DEFAULT = wordId('default');
export const KW_DELETE = wordId('delete');
export const KW_DO = wordId('do');
export const KW_ELSE = wordId('else');
export const KW_ENUM = wordId('enum');
export const KW_EXPORT = wordId('export');
export const KW_EXTENDS = wordId('extends');
export const KW_FINALLY = wordId('finally');
export const KW_FOR = wordId('for');
export const KW_FROM = wordId('from');
export const KW_FUNCTION = wordId('function');
export const KW_GET = wordId('get');
export const KW_GLOBAL = wordId('global');
export const KW_IF = wordId('if');
export const KW_IMPLEMENTS = wordId('implements');
export const KW_IMPORT = wordId('import');
export const KW_IN = wordId('in');
export const KW_INFER = wordId('infer');
export const KW_INSTANCEOF = wordId('instanceof');
export const KW_INTERFACE = wordId('interface');
export const KW_IS = wordId('is');
export const KW_KEYOF = wordId('keyof');
export const KW_LET = wordId('let');
export const KW_MODULE = wordId('module');
export const KW_NAMESPACE = wordId('namespace');
export const KW_NEW = wordId('new');
export const KW_OF = wordId('of');
export const KW_OVERRIDE = wordId('override');
export const KW_PRIVATE = wordId('private');
export const KW_PROTECTED = wordId('protected');
export const KW_PUBLIC = wordId('public');
export const KW_READONLY = wordId('readonly');
export const KW_RETURN = wordId('return');
export const KW_SATISFIES = wordId('satisfies');
export const KW_SET = wordId('set');
export const KW_STATIC = wordId('static');
export const KW_SWITCH = wordId('switch');
export const KW_THROW = wordId('throw');
export const KW_TRY = wordId('try');
export const KW_TYPE = wordId('type');
export const KW_TYPEOF = wordId('typeof');
export const KW_UNIQUE = wordId('unique');
export const KW_USING = wordId('using');
export const KW_VAR = wordId('var');
export const KW_VOID = wordId('void');
export const KW_WHILE = wordId('while');
export const KW_WITH = wordId('with');
export const KW_YIELD = wordId('yield');

// PERF: A name is matched against the words of its first character and length in place, so names aren't sliced
// into strings to be looked up
const MAX_WORD_LENGTH = 11;
const wordsByFirstCharAndLength: number[][] = [];

for (let i = 0; i < 26 * (MAX_WORD_LENGTH + 1); i++) {
    wordsByFirstCharAndLength.push([]);
}

for (let i = 0; i < words.length; i++) {
    const word = words[i];

    wordsByFirstCharAndLength[(word.charCodeAt(0) - 97) * (MAX_WORD_LENGTH + 1) + word.length].push(i + 1);
}

// ASCII characters of names: 1 for the start and the rest of a name, 2 for the rest only (digits)
const nameChars = new Uint8Array(128);

for (let i = 0; i < 128; i++) {
    if ((i >= 65 && i <= 90) || (i >= 97 && i <= 122) || i === 36 /* $ */ || i === 95 /* _ */) {
        nameChars[i] = 1;
    } else if (i >= 48 && i <= 57) {
        nameChars[i] = 2;
    }
}

// Tokens of a single character which never starts a longer token
const singleCharTokens = new Int8Array(128).fill(NONE);

singleCharTokens[40 /* ( */] = PAREN_L;
singleCharTokens[41 /* ) */] = PAREN_R;
singleCharTokens[91 /* [ */] = BRACKET_L;
singleCharTokens[93 /* ] */] = BRACKET_R;
singleCharTokens[123 /* { */] = BRACE_L;
singleCharTokens[125 /* } */] = BRACE_R;
singleCharTokens[59 /* ; */] = SEMICOLON;
singleCharTokens[44 /* , */] = COMMA;
singleCharTokens[58 /* : */] = COLON;
singleCharTokens[126 /* ~ */] = TILDE;
singleCharTokens[64 /* @ */] = AT;

// The state of a token to return to after looking ahead: pos, type, start, end, previousEnd, prec, word,
// newlineBefore and commentStart
const STATE_SIZE = 9;

function isLineTerminator(c: number) {
    return c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
}

function isUnicodeSpace(c: number) {
    return (
        c === 0xa0 ||
        c === 0xfeff ||
        c === 0x1680 ||
        (c >= 0x2000 && c <= 0x200a) ||
        c === 0x202f ||
        c === 0x205f ||
        c === 0x3000
    );
}

// PERF: Native searches of single characters; a search of a character above \xFF in a one-byte string ends at once
function hasUnusualLineTerminators(source: string) {
    if (source.indexOf('\u2028') !== -1 || source.indexOf('\u2029') !== -1) {
        return true;
    }

    for (let i = source.indexOf('\r'); i !== -1; i = source.indexOf('\r', i + 1)) {
        if (source.charCodeAt(i + 1) !== 10) {
            return true;
        }
    }

    return false;
}

export class SourceLexer {
    source = '';
    length = 0;
    typescript = false;
    unusualLineTerminators = false; // \r without \n, \u2028 or \u2029 in the source

    // The current token
    pos = 0; // the offset to read the next token from
    type = EOF;
    start = 0;
    end = 0;
    previousEnd = 0; // the end of the previous token
    prec = 0; // the precedence of a binary operator, 0 for other tokens
    word = 0; // the id of a recognized word, 0 for other names and other tokens
    newlineBefore = false; // a line terminator between the previous token and this one
    commentStart = NONE; // the start of the first comment between the previous token and this one

    // The token after the current one, set by peek()
    peekType = EOF;
    peekWord = 0;
    peekNewlineBefore = false;

    states = new Int32Array(STATE_SIZE * 16);
    stateCount = 0;

    // Starts reading a source at its first token
    reset(source: string, typescript: boolean) {
        this.source = source;
        this.length = source.length;
        this.typescript = typescript;
        this.unusualLineTerminators = hasUnusualLineTerminators(source);
        this.pos = 0;
        this.end = 0;
        this.stateCount = 0;

        // a hashbang is a comment
        if (source.charCodeAt(0) === 35 /* # */ && source.charCodeAt(1) === 33 /* ! */) {
            this.pos = this.lineCommentEnd(2);
        }

        this.next();
    }

    fail(message: string, offset = this.start): never {
        throw new SyntaxError(`${message} at ${offset}`);
    }

    unexpected(): never {
        return this.fail(this.type === EOF
            ? 'Unexpected end of input'
            : `Unexpected token "${this.source.slice(this.start, this.end)}"`
        );
    }

    // Reads the next token where an expression may start, so a slash starts a regular expression
    next() {
        this.read(true);
    }

    // Reads the next token after an operand, so a slash is a division
    nextAfterOperand() {
        this.read(false);
    }

    //
    // Looking ahead
    //

    // Saves the current token to return to it; returns the saved state for restore() and discardSaved().
    // A state is returned to by its index, so the states saved after it are dropped even if a failed look ahead
    // hasn't returned to them
    save() {
        const state = this.stateCount;
        let offset = state * STATE_SIZE;

        if (offset === this.states.length) {
            const states = new Int32Array(this.states.length * 2);

            states.set(this.states);
            this.states = states;
        }

        const states = this.states;

        states[offset++] = this.pos;
        states[offset++] = this.type;
        states[offset++] = this.start;
        states[offset++] = this.end;
        states[offset++] = this.previousEnd;
        states[offset++] = this.prec;
        states[offset++] = this.word;
        states[offset++] = this.newlineBefore ? 1 : 0;
        states[offset] = this.commentStart;
        this.stateCount++;

        return state;
    }

    // Returns to a saved token
    restore(state: number) {
        const states = this.states;
        let offset = state * STATE_SIZE;

        this.stateCount = state;

        this.pos = states[offset++];
        this.type = states[offset++];
        this.start = states[offset++];
        this.end = states[offset++];
        this.previousEnd = states[offset++];
        this.prec = states[offset++];
        this.word = states[offset++];
        this.newlineBefore = states[offset++] === 1;
        this.commentStart = states[offset];
    }

    // Stays at the current token, forgetting a saved one
    discardSaved(state: number) {
        this.stateCount = state;
    }

    // Reads the token after the current one into peekType, peekWord and peekNewlineBefore, staying at the current one
    peek() {
        const state = this.save();

        this.read(false);
        this.peekType = this.type;
        this.peekWord = this.word;
        this.peekNewlineBefore = this.newlineBefore;
        this.restore(state);
    }

    //
    // Tokens
    //

    read(regexpAllowed: boolean) {
        this.previousEnd = this.end;
        this.newlineBefore = false;
        this.commentStart = NONE;
        this.prec = 0;
        this.word = 0;
        this.skipSpace();
        this.start = this.pos;

        if (this.pos >= this.length) {
            this.type = EOF;
            this.end = this.pos;
            return;
        }

        const c = this.source.charCodeAt(this.pos);

        if (c < 128) {
            if (nameChars[c] === 1) {
                this.readName();
                return;
            }

            const type = singleCharTokens[c];

            if (type !== NONE) {
                this.type = type;
                this.end = ++this.pos;
                return;
            }

            this.readPunctuation(c, regexpAllowed);
            return;
        }

        this.readName();
    }

    readPunctuation(c: number, regexpAllowed: boolean) {
        const source = this.source;
        const next = source.charCodeAt(this.pos + 1);

        switch (c) {
            case 34: // "
            case 39: // '
                this.readString(c);
                return;

            case 96: // `
                this.readTemplate(this.pos + 1);
                return;

            case 46: // .
                if (next >= 48 && next <= 57) {
                    this.readNumber();
                } else if (next === 46 && source.charCodeAt(this.pos + 2) === 46) {
                    this.operator(ELLIPSIS, 3, 0);
                } else {
                    this.operator(DOT, 1, 0);
                }
                return;

            case 61: // =
                if (next === 62 /* > */) {
                    this.operator(ARROW, 2, 0);
                } else if (next === 61 /* = */) {
                    this.operator(BINARY, source.charCodeAt(this.pos + 2) === 61 ? 3 : 2, 6);
                } else {
                    this.operator(ASSIGN, 1, 0);
                }
                return;

            case 33: // !
                if (next === 61 /* = */) {
                    this.operator(BINARY, source.charCodeAt(this.pos + 2) === 61 ? 3 : 2, 6);
                } else {
                    this.operator(BANG, 1, 0);
                }
                return;

            case 60: // <
                if (next === 60 /* < */) {
                    this.operatorOrAssign(2, 8);
                } else if (next === 61 /* = */) {
                    this.operator(BINARY, 2, PREC_RELATIONAL);
                } else {
                    this.operator(LT, 1, PREC_RELATIONAL);
                }
                return;

            case 62: // >
                this.readGreaterThan();
                return;

            case 43: // +
            case 45: // -
                if (next === c) {
                    this.operator(INC_DEC, 2, 0);
                } else if (next === 61 /* = */) {
                    this.operator(OPERATOR_ASSIGN, 2, 0);
                } else {
                    this.operator(PLUS_MINUS, 1, 9);
                }
                return;

            case 42: // *
                if (next === 42 /* * */) {
                    this.operatorOrAssign(2, PREC_EXPONENT);
                } else if (next === 61 /* = */) {
                    this.operator(OPERATOR_ASSIGN, 2, 0);
                } else {
                    this.operator(STAR, 1, 10);
                }
                return;

            case 47: // /
                if (regexpAllowed) {
                    this.readRegExp();
                } else {
                    this.operatorOrAssign(1, 10);
                }
                return;

            case 37: // %
                this.operatorOrAssign(1, 10);
                return;

            case 94: // ^
                this.operatorOrAssign(1, 4);
                return;

            case 38: // &
                if (next === 38 /* & */) {
                    this.operatorOrAssign(2, 2);
                } else if (next === 61 /* = */) {
                    this.operator(OPERATOR_ASSIGN, 2, 0);
                } else {
                    this.operator(AMPERSAND, 1, 5);
                }
                return;

            case 124: // |
                if (next === 124 /* | */) {
                    this.operatorOrAssign(2, 1);
                } else if (next === 61 /* = */) {
                    this.operator(OPERATOR_ASSIGN, 2, 0);
                } else {
                    this.operator(PIPE, 1, 3);
                }
                return;

            case 63: { // ?
                const afterNext = source.charCodeAt(this.pos + 2);

                if (next === 63 /* ? */) {
                    this.operatorOrAssign(2, 1);
                } else if (next === 46 /* . */ && !(afterNext >= 48 && afterNext <= 57)) {
                    this.operator(QUESTION_DOT, 2, 0);
                } else {
                    this.operator(QUESTION, 1, 0);
                }
                return;
            }

            case 35: { // #
                const start = this.pos++;

                this.readName();
                this.type = PRIVATE_NAME;
                this.start = start;
                this.word = 0;
                this.prec = 0;
                return;
            }
        }

        if (c >= 48 && c <= 57) {
            this.readNumber();
        } else if (c === 92 /* \ */) {
            this.readName();
        } else {
            this.fail(`Unexpected character "${source[this.pos]}"`, this.pos);
        }
    }

    operator(type: number, size: number, prec: number) {
        this.type = type;
        this.prec = prec;
        this.pos += size;
        this.end = this.pos;
    }

    // A binary operator of a size, or its compound assignment when "=" follows it
    operatorOrAssign(size: number, prec: number) {
        if (this.source.charCodeAt(this.pos + size) === 61 /* = */) {
            this.operator(OPERATOR_ASSIGN, size + 1, 0);
        } else {
            this.operator(BINARY, size, prec);
        }
    }

    // >, >=, >>, >>=, >>> and >>>=
    readGreaterThan() {
        const source = this.source;
        let size = 1;

        while (size < 3 && source.charCodeAt(this.pos + size) === 62 /* > */) {
            size++;
        }

        const assign = source.charCodeAt(this.pos + size) === 61 /* = */;

        if (size === 1 && assign) {
            this.operator(BINARY, 2, PREC_RELATIONAL);
        } else if (size === 1) {
            this.operator(GT, 1, PREC_RELATIONAL);
        } else if (assign) {
            this.operator(OPERATOR_ASSIGN, size + 1, 0);
        } else {
            this.operator(BINARY, size, 8);
        }
    }

    // The first character of the token; type arguments may open or close with a token starting with < or >,
    // e.g. << or >=
    firstChar() {
        return this.source.charCodeAt(this.start);
    }

    // Takes the first character of the token as a token of its own, the rest is read as the next token
    splitFirstChar(type: number) {
        this.type = type;
        this.prec = 0;
        this.end = this.pos = this.start + 1;
    }

    // PERF: Hot loops of the lexer advance a local offset and keep the source in a local variable
    readName() {
        const source = this.source;
        const length = this.length;
        const start = this.pos;
        let offset = start;
        let escaped = false;

        while (offset < length) {
            const c = source.charCodeAt(offset);

            if (c < 128) {
                if (nameChars[c] !== 0) {
                    offset++;
                } else if (c === 92 /* \ */) {
                    offset = this.unicodeEscapeEnd(offset);
                    escaped = true;
                } else {
                    break;
                }
            } else {
                const codePoint = source.codePointAt(offset)!;
                const valid = offset === start
                    ? isIdentifierStart(codePoint)
                    : isIdentifierChar(codePoint);

                if (!valid) {
                    break;
                }

                offset += codePoint > 0xffff ? 2 : 1;
            }
        }

        if (offset === start) {
            this.fail(`Unexpected character "${source[offset]}"`, offset);
        }

        this.pos = offset;
        this.type = NAME;
        this.end = offset;

        if (!escaped) {
            this.word = this.wordAt(start, offset - start);
            this.prec = this.wordPrecedence(this.word);
        }
    }

    // \uXXXX or \u{X...}
    unicodeEscapeEnd(offset: number) {
        if (this.source.charCodeAt(offset + 2) !== 123 /* { */) {
            return offset + 6;
        }

        const end = this.source.indexOf('}', offset + 3);

        if (end === -1) {
            this.fail('Invalid escape', offset);
        }

        return end + 1;
    }

    wordAt(start: number, size: number) {
        const first = this.source.charCodeAt(start);

        if (size < 2 || size > MAX_WORD_LENGTH || first < 97 /* a */ || first > 122 /* z */) {
            return 0;
        }

        const candidates = wordsByFirstCharAndLength[(first - 97) * (MAX_WORD_LENGTH + 1) + size];

        for (let i = 0; i < candidates.length; i++) {
            if (this.source.startsWith(words[candidates[i] - 1], start)) {
                return candidates[i];
            }
        }

        return 0;
    }

    // Words of binary operators: in, instanceof, and as and satisfies of TypeScript
    wordPrecedence(word: number) {
        if (word === KW_IN || word === KW_INSTANCEOF) {
            return PREC_RELATIONAL;
        }

        if (this.typescript && (word === KW_AS || word === KW_SATISFIES)) {
            return PREC_RELATIONAL;
        }

        return 0;
    }

    readNumber() {
        // PERF: Numbers are skimmed as runs of name characters and dots, with the sign of a decimal exponent;
        // their values don't matter
        const source = this.source;
        const length = this.length;
        const prefix = source.charCodeAt(this.pos + 1) | 32;
        const decimal = (
            source.charCodeAt(this.pos) !== 48 /* 0 */ ||
            (prefix !== 120 /* x */ && prefix !== 98 /* b */ && prefix !== 111 /* o */)
        );
        let offset = this.pos + 1;

        while (offset < length) {
            const c = source.charCodeAt(offset);
            const exponentSign = (
                (c === 43 /* + */ || c === 45 /* - */) &&
                decimal &&
                (source.charCodeAt(offset - 1) | 32) === 101 /* e */
            );

            if (c < 128 && (nameChars[c] !== 0 || c === 46 /* . */)) {
                offset++;
            } else if (exponentSign) {
                offset++;
            } else {
                break;
            }
        }

        this.type = NUMBER;
        this.pos = this.end = offset;
    }

    // PERF: The closing quote is searched natively, a quote after an odd number of backslashes is escaped.
    // Sources are valid, so line terminators aren't looked for
    readString(quote: number) {
        const source = this.source;
        const quoteChar = quote === 34 ? '"' : '\'';
        let end = source.indexOf(quoteChar, this.pos + 1);

        while (true) {
            if (end === -1) {
                this.fail('Unterminated string', this.pos);
            }

            let backslashes = 0;

            while (source.charCodeAt(end - 1 - backslashes) === 92 /* \ */) {
                backslashes++;
            }

            if ((backslashes & 1) === 0) {
                break;
            }

            end = source.indexOf(quoteChar, end + 1);
        }

        this.type = STRING;
        this.pos = this.end = end + 1;
    }

    // Reads a template from an offset after a backtick, or after the brace closing a substitution
    readTemplate(offset: number) {
        const source = this.source;
        const length = this.length;

        while (offset < length) {
            const c = source.charCodeAt(offset);

            if (c === 96 /* ` */) {
                this.type = TEMPLATE;
                this.pos = this.end = offset + 1;
                return;
            }

            if (c === 92 /* \ */) {
                offset += 2;
            } else if (c === 36 /* $ */ && source.charCodeAt(offset + 1) === 123 /* { */) {
                this.type = TEMPLATE_HEAD;
                this.pos = this.end = offset + 2;
                return;
            } else {
                offset++;
            }
        }

        this.fail('Unterminated template', this.start);
    }

    // Continues a template from the brace token closing its substitution
    continueTemplate() {
        this.readTemplate(this.start + 1);
    }

    readRegExp() {
        const source = this.source;
        let offset = this.pos + 1;
        let inClass = false;

        while (true) {
            if (offset >= this.length) {
                this.fail('Unterminated regular expression', this.pos);
            }

            const c = source.charCodeAt(offset);

            if (c === 92 /* \ */) {
                offset += 2;
                continue;
            }

            if (c === 10 || c === 13) {
                this.fail('Unterminated regular expression', this.pos);
            }

            if (c === 91 /* [ */) {
                inClass = true;
            } else if (c === 93 /* ] */) {
                inClass = false;
            } else if (c === 47 /* / */ && !inClass) {
                break;
            }

            offset++;
        }

        // flags
        offset++;

        while (offset < this.length && source.charCodeAt(offset) < 128 && nameChars[source.charCodeAt(offset)] !== 0) {
            offset++;
        }

        this.type = REGEXP;
        this.pos = this.end = offset;
    }

    //
    // Space and comments
    //

    skipSpace() {
        const source = this.source;
        const length = this.length;
        let offset = this.pos;
        let newline = false;

        while (offset < length) {
            const c = source.charCodeAt(offset);

            if (c === 32 || c === 9 || c === 11 || c === 12) {
                offset++;
            } else if (c === 10 || c === 13) {
                newline = true;
                offset++;
            } else if (c === 47 /* / */) {
                const next = source.charCodeAt(offset + 1);

                if (next === 47 /* / */) {
                    if (this.commentStart === NONE) {
                        this.commentStart = offset;
                    }

                    offset = this.lineCommentEnd(offset + 2);
                } else if (next === 42 /* * */) {
                    const commentEnd = source.indexOf('*/', offset + 2);

                    if (commentEnd === -1) {
                        this.fail('Unterminated comment', offset);
                    }

                    if (this.commentStart === NONE) {
                        this.commentStart = offset;
                    }

                    if (!newline && this.hasLineTerminator(offset + 2, commentEnd)) {
                        newline = true;
                    }

                    offset = commentEnd + 2;
                } else {
                    break;
                }
            } else if (c > 127 && (c === 0x2028 || c === 0x2029)) {
                newline = true;
                offset++;
            } else if (c > 127 && isUnicodeSpace(c)) {
                offset++;
            } else {
                break;
            }
        }

        this.pos = offset;

        if (newline) {
            this.newlineBefore = true;
        }
    }

    // The offset of the line terminator ending a line comment
    lineCommentEnd(offset: number) {
        // PERF: A source with \n line terminators only is searched natively
        if (!this.unusualLineTerminators) {
            const end = this.source.indexOf('\n', offset);

            return end !== -1
                ? end
                : this.length;
        }

        while (offset < this.length && !isLineTerminator(this.source.charCodeAt(offset))) {
            offset++;
        }

        return offset;
    }

    hasLineTerminator(start: number, end: number) {
        const lineFeed = this.source.indexOf('\n', start);

        if (lineFeed !== -1 && lineFeed < end) {
            return true;
        }

        if (this.unusualLineTerminators) {
            for (let i = start; i < end; i++) {
                if (isLineTerminator(this.source.charCodeAt(i))) {
                    return true;
                }
            }
        }

        return false;
    }

    //
    // JSX
    //

    // Reads a token inside a JSX tag: a name with dashes, colons and dots, a string without escapes,
    // or one of < > / = { }
    nextJsxTag() {
        this.previousEnd = this.end;
        this.commentStart = NONE;
        this.skipSpace();
        this.start = this.pos;

        if (this.pos >= this.length) {
            this.type = EOF;
            this.end = this.pos;
            return;
        }

        const source = this.source;
        const c = source.charCodeAt(this.pos);

        switch (c) {
            case 60: // <
                this.operator(LT, 1, 0);
                return;
            case 62: // >
                this.operator(GT, 1, 0);
                return;
            case 47: // /
                this.operator(SLASH, 1, 0);
                return;
            case 61: // =
                this.operator(ASSIGN, 1, 0);
                return;
            case 123: // {
                this.operator(BRACE_L, 1, 0);
                return;
            case 34: // "
            case 39: { // '
                const end = source.indexOf(c === 34 ? '"' : '\'', this.pos + 1);

                if (end === -1) {
                    this.fail('Unterminated JSX attribute', this.pos);
                }

                this.type = STRING;
                this.pos = this.end = end + 1;
                return;
            }
        }

        let offset = this.pos;

        while (offset < this.length) {
            const char = source.charCodeAt(offset);
            const nameChar = char < 128
                ? nameChars[char] !== 0 || char === 45 /* - */ || char === 58 /* : */ || char === 46 /* . */
                : isIdentifierChar(char);

            if (!nameChar) {
                break;
            }

            offset++;
        }

        if (offset === this.pos) {
            this.fail(`Unexpected character "${source[offset]}" in JSX`, offset);
        }

        this.type = NAME;
        this.word = 0;
        this.pos = this.end = offset;
    }

    // Skips text of JSX children up to a child element or a closing tag (LT), or an expression container (BRACE_L)
    nextJsxChild() {
        const source = this.source;
        let offset = this.pos;

        while (offset < this.length) {
            const c = source.charCodeAt(offset);

            if (c === 60 /* < */ || c === 123 /* { */) {
                this.previousEnd = this.end;
                this.type = c === 60
                    ? LT
                    : BRACE_L;
                this.start = offset;
                this.pos = this.end = offset + 1;
                return;
            }

            offset++;
        }

        this.fail('Unterminated JSX element', this.pos);
    }

    // Whether "<" of JSX children starts a closing tag
    atJsxClosingTag() {
        this.skipSpace();

        return this.source.charCodeAt(this.pos) === 47 /* / */;
    }

    // Skips a closing tag after its "</", up to its ">"
    skipJsxClosingTag() {
        const end = this.source.indexOf('>', this.pos);

        if (end === -1) {
            this.fail('Unterminated JSX closing tag', this.pos);
        }

        this.pos = this.end = end + 1;
    }

    // Reads the current token again from its start, e.g. JSX after type arguments read as JavaScript
    rewind() {
        this.pos = this.start;
    }
}
