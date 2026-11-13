import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseFunctionRangesWithBabel } from '../../../test/helpers/babel-function-ranges.js';
import { parseScriptSourceRanges } from './parse-script-source-ranges.js';

// The parser follows the grammar only as far as functions depend on it, so it's compared with the ranges
// of a full syntax tree on sources where a shortcut of the grammar could go wrong
function assertSameAsBabel(source: string, url: string) {
    const parsed = parseScriptSourceRanges(source, url, true);
    // self sizes come from the index of the ranges, they are tested on their own
    const ranges = parsed.ranges.map(range => ({ ...range, selfSize: 0 }));

    assert.equal(parsed.error, undefined);
    assert.deepEqual(ranges, parseFunctionRangesWithBabel(source, url));
}

test.each([
    [
        'function declarations and expressions',
        [
            'function a(x) { return function b() {} }',
            'const c = function () {}, d = function* e() {};'
        ]
    ],
    [
        'async functions and arrow functions',
        [
            'async function a() { await b(); }',
            'const c = async () => 1, d = async x => x, e = async (x, y) => { await x; };'
        ]
    ],
    [
        'async as an identifier',
        [
            'async(1);',
            'async = 2;',
            'const f = async => async;',
            'async',
            '(() => 1);'
        ]
    ],
    [
        'arrow function bodies ending an expression',
        [
            'const a = x => x ? y => y : z => z, b = () => () => 1;',
            'f(() => 1, () => {});',
            'g(x => ({ y: () => 2 }))'
        ]
    ],
    [
        'generators and yield',
        [
            'function* g() { yield; yield 1; yield* h(); const x = yield () => 1; }'
        ]
    ],
    [
        'parenthesized functions',
        [
            'const a = (function () {}), b = (() => 1), c = (0, function () {});',
            '(function () {})();',
            '(() => {})();'
        ]
    ],
    [
        'a function followed by a member access or a call',
        [
            'const a = function () {}.bind(this), b = class {}.name, c = function () {}(), d = (() => 1)()'
        ]
    ],
    [
        'assignments',
        [
            'a = function () {};',
            'a.b = () => 1;',
            'a ||= () => 2;',
            'a ??= function () {};',
            '[a = () => 1] = [];',
            '({ a = () => 2 } = {});'
        ]
    ],
    [
        'operators',
        [
            'x = a || function () {};',
            'y = !function () {}();',
            'z = void function () {};',
            'w = a ? () => 1 : () => 2;',
            'v = a + (() => 1) + function () {};'
        ]
    ],
    [
        'exponent and comparisons',
        [
            'a ** b ** (() => 1);',
            'a < b > (() => 1);',
            'x = a >>> b;',
            'y >>= c >= d;'
        ]
    ],
    [
        'regular expressions and division',
        [
            'a = b / c / d;',
            'e = /[/]\\//g.test(f) / 2;',
            'if (x) /re/.test(y);',
            'x = (a) / 2;',
            'y = a++ / 2;',
            'function f() {}',
            '/re/.test(z);'
        ]
    ],
    [
        'templates',
        [
            'const a = `x${() => 1}y${`z${function () {}}`}w`;',
            'tag`${a => a}`;',
            'b = `${{ c: () => 1 }}`;'
        ]
    ],
    [
        'object literals',
        [
            'const o = {',
            '    a() {},',
            '    get b() { return 1; },',
            '    set b(v) {},',
            '    async c() {},',
            '    *d() {},',
            '    async *e() {},',
            '    f: () => 1,',
            '    "g": function () {},',
            '    1: () => 2,',
            '    [h]: () => 3,',
            '    [i]() {},',
            '    j,',
            '    ...k,',
            '    get: 1,',
            '    set() {},',
            '    async: () => 4',
            '};'
        ]
    ],
    [
        'classes',
        [
            'class A extends B {',
            '    constructor() { super(); }',
            '    m() {}',
            '    static n() {}',
            '    get o() { return 1; }',
            '    set o(v) {}',
            '    #p() {}',
            '    static #q() {}',
            '    async *r() {}',
            '    s = () => 1;',
            '    #t = function () {};',
            '    static u = class {};',
            '    static { const v = () => 1; }',
            '    "w"() {}',
            '    [x]() {}',
            '}'
        ]
    ],
    [
        'class expressions and heritage',
        [
            'const A = class {}, B = class C extends (() => D) {}, E = class extends mixin(F, () => G) {};'
        ]
    ],
    [
        'default constructors',
        [
            'class A {}',
            'class B { constructor() {} }',
            'class C { static constructor() {} }',
            'class D { "constructor"() {} }'
        ]
    ],
    [
        'parameters with default values',
        [
            'function f(a = () => 1, { b = () => 2 } = {}, [c = () => 3] = [], ...d) {}',
            'const g = (a = function () {}) => a;'
        ]
    ],
    [
        'statements',
        [
            'label: for (const a of b) { if (a) continue label; else break; }',
            'for (let i = 0, f = () => 1; i < 1; i++) {}',
            'for (x in y) {}',
            'while (x) x--;',
            'do { x++ }',
            'while (x);',
            'switch (x) { case () => 1: break; default: }',
            'try { a() }',
            'catch { b() }',
            'finally { c() }',
            'try {}',
            'catch ({ e = () => 1 }) {}'
        ]
    ],
    [
        'automatic semicolon insertion',
        [
            'const a = 1',
            'const b = () => 1',
            '(function () {})',
            'let c = 1',
            '/re/g.test(c)',
            'function d() { return',
            '() => 1 }'
        ]
    ],
    [
        'comments before functions',
        [
            '/* a */ function a() {}',
            '// b',
            'const b = /* c */ () => 1, c = /* d */ (/* e */ function () {});',
            'f(/* g */ () => 1, /* h */ function () {});',
            'x = a || /* i */ function () {};',
            '/* j */ (function () {})();',
            'y = (/* k */ a, /* l */ () => 1);'
        ]
    ],
    [
        'comments before members and exports',
        [
            'const o = { /* a */ m() {}, /* b */ p: /* c */ () => 1 };',
            'class A { /* d */ m() {} /* e */ static n() {} }',
            '/* f */ export function f() {}',
            'export /* g */ function g() {}',
            'export default /* h */ () => 1;'
        ]
    ],
    [
        'modules',
        [
            'import a, { b as c }',
            'from "d";',
            'import * as e from "f";',
            'import "g";',
            'export { a, c as h };',
            'export * from "i";',
            'export * as j from "k";',
            'export const l = () => 1;',
            'export default function () {}',
            'export class M {}',
            'import("n").then(() => 1);',
            'import.meta.url;'
        ]
    ],
    [
        'line terminators',
        [
            'function a() {}\r',
            'const b = () => 1\rfunction c() {}\u2028const d = function () {}\u2029class E {}'
        ]
    ],
    [
        'unicode names and escapes',
        [
            'const ä = () => 1, \\u0062 = function () {}, o = { "\\u0063": () => 2, \'d\\\'\': () => 3 };',
            'class ℮ {}'
        ]
    ],
    [
        'new and member names',
        [
            'new A(() => 1);',
            'function B() { new.target; }',
            'a.function = () => 1;',
            'a.class.new = function () {};',
            'class C extends D { m() { super.x = () => 3; } }',
            'this.y = () => 2;'
        ]
    ],
    [
        'parentheses in comments before parameters',
        [
            'function a /* ( */ () {}',
            'const b = function /* ( */ () {};',
            'class C { m /* ( */ () {} }',
            'const d = { m /* ( */ () {} };'
        ]
    ],
    [
        'await as an operator and an identifier',
        [
            'async function f() { await (() => 1)(); await x; }',
            'var await;',
            'await = () => 2;'
        ]
    ]
])('agrees with babel on JavaScript: %s', (_, lines) => {
    assertSameAsBabel(lines.join('\n'), 'fixture.js');
});

test.each([
    [
        'annotations',
        [
            'let a: () => void = () => {};',
            'function b(c: (d: number) => string, e?: { f(): void }): Promise<() => void> { return null!; }',
            'const g = (h: string, i?: number): void => {};'
        ]
    ],
    [
        'type parameters and arguments',
        [
            'function a<T extends (x: number) => void>(b: T) {}',
            'const c = <T,>(d: T) => d, e = <T>(f: T): T => f;',
            'g<string>(() => 1);',
            'h<A<B<C>>>(() => 2);',
            'const i = j < k, l = m > (() => 1);',
            'n<() => void>`${() => 3}`;'
        ]
    ],
    [
        'generic methods',
        [
            'class A { m<T>() {} n<T extends (x: T) => void = () => void>(a: T) {} }',
            'const o = { p<T>() { return () => 1; } };'
        ]
    ],
    [
        'as, satisfies and non-null',
        [
            'const a = (() => 1) as () => number;',
            'const b = function () {} satisfies Function;',
            'const c = d!(() => 2), e = <F>(() => 3);',
            'const g = h as unknown as (x: number) => void;'
        ]
    ],
    [
        'declarations',
        [
            'type A<T> = { a(): void; b: () => void };',
            'interface C extends D<E> { f(): void; }',
            'declare function g(): void;',
            'declare const h: () => void;',
            'declare class I { j(): void; }',
            'declare module "k" { function l(): void; }',
            'declare global { interface M {} }',
            'namespace N.O { export const p = () => 1; }',
            'abstract class Q { abstract r(): void; s() {} }'
        ]
    ],
    [
        'overloads',
        [
            'function a(b: string): void;',
            'function a(b: number): void;',
            'function a(b) {}',
            'class C { constructor(); constructor(d?) {} m(): void; m(e?) {} }',
            'export default function f(): void;'
        ]
    ],
    [
        'enums',
        [
            'enum A { B, C = () => 1, "D" = 2 }',
            'const enum E { F }',
            'declare enum G { H }',
            'export enum I { J = function () {} }'
        ]
    ],
    [
        'parameter properties and decorators',
        [
            'class A {',
            '    constructor(private b = () => 1, public readonly c?: () => void) {}',
            '    @dec() m() {}',
            '    @dec n = () => 2;',
            '}',
            '@dec class D {}',
            '@dec() export class E {}',
            'export @dec class F {}',
            '/* c */ @dec',
            'class G {}'
        ]
    ],
    [
        'class members of TypeScript',
        [
            'class A<T> extends B<T> implements C, D<T> {',
            '    private e?: () => void;',
            '    protected f!: number;',
            '    public static readonly g = () => 1;',
            '    declare h: string;',
            '    override i() {}',
            '    [k: string]: unknown;',
            '}'
        ]
    ],
    [
        'types with functions inside',
        [
            'let a: { b: () => void; c(d: () => void): void };',
            'let e: [() => void, (f: number) => void];',
            'let g: new () => H;',
            'let i: abstract new (j: () => void) => K;',
            'type L = `${M}-${N}`;',
            'type O<P> = P extends (infer Q extends string) ? Q : never;',
            'function r(s: unknown): asserts s is () => void {}'
        ]
    ],
    [
        'import and export of TypeScript',
        [
            'import type { A }',
            'from "b";',
            'import c = require("d");',
            'import e = F.G;',
            'type H = 1;',
            'export type { H };',
            'export = () => 1;',
            'export as namespace I;',
            'export import J = K.L;'
        ]
    ],
    [
        'arrow functions with return types in conditionals',
        [
            'const f = g ? (h) : (i): number => 1;',
            'const j = k ? (l) : m;',
            'const n = o ? async (p: Q): Promise<R> => p : null;'
        ]
    ]
])('agrees with babel on TypeScript: %s', (_, lines) => {
    assertSameAsBabel(lines.join('\n'), 'fixture.ts');
});

test.each([
    [
        'elements',
        [
            'const a = <div onClick={() => 1}',
            'render={function () {}}>{items.map(item => <span key={item}>{item}</span>)}</div>;'
        ]
    ],
    [
        'fragments, self-closing elements and spreads',
        [
            'const a = <><A {...props}',
            'b={() => 1}',
            '/><B.C d="e" f=\'g\' h /></>;',
            'const i = <J k={<L m={() => 2} />}',
            '/>;'
        ]
    ],
    [
        'comments and text',
        [
            'const a = <div>',
            '  {/* comment */}',
            '  text > more ;',
            'text',
            '  {// line',
            '  () => 1}',
            '</div>;'
        ]
    ],
    [
        'type arguments and generic arrow functions',
        [
            'const a = <A<string> b={() => 1}',
            '/>;',
            'const c = <T,>(d: T) => d;',
            'const e = <T extends unknown>(f: T) => <div>{f}</div>;'
        ]
    ],
    [
        'namespaced and dashed attributes',
        [
            'const a = <svg xlink:href="b" data-c={() => 1}',
            'aria-d />;'
        ]
    ]
])('agrees with babel on JSX: %s', (_, lines) => {
    assertSameAsBabel(lines.join('\n'), 'fixture.tsx');
});

// Sources are expected to be valid, a source the parser can't read is refused rather than given wrong ranges
test.each([
    ['an unclosed parenthesis', 'run(() => 1;'],
    ['an unclosed brace', 'function f() { return 1;'],
    ['an extra closing brace', 'function f() {} }'],
    ['an unterminated string', 'const s = "text;'],
    ['an unterminated template', 'const s = `text ${1}'],
    ['an unterminated regular expression', 'const r = /text'],
    ['an unterminated comment', 'function f() {} /* comment']
])('refuses a source with %s', (_, source) => {
    const parsed = parseScriptSourceRanges(source, 'fixture.js', true);

    assert.equal(parsed.parsed, false);
    assert.equal(typeof parsed.error, 'string');
    assert.deepEqual(parsed.ranges, []);
});
