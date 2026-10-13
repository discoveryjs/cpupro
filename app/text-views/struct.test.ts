import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { Model } from '@discoveryjs/discovery/lib/main/model.js';
import type { ValueAnnotationContext } from '@discoveryjs/discovery/lib/views/struct/render-annotations.js';
import defineStruct from './struct.js';

const model = new Model();

defineStruct(model);

async function render(data: unknown, props: Record<string, unknown> = {}) {
    const { text } = await model.textView.renderString(null, {
        view: 'struct',
        ...props
    }, data);

    return text;
}

test('struct defaults to the compact Discovery representation', async () => {
    const data = { foo: 'bar', nested: { value: 1 }, values: [1, 2] };
    const text = await render(data);

    assert.equal(text, '{ foo: "bar", nested: {\u2026}, values: [1, 2] }');
});

test('expanded controls structure depth without expanding numeric vectors', async () => {
    const data = { nested: { value: 1 }, values: [1, 2, 3] };
    const text = await render(data, { expanded: 2, limitCollapsed: 2 });

    assert.equal(text, [
        '{',
        '    nested: {',
        '        value: 1',
        '    },',
        '    values: [1, 2, \u2026 1 more]',
        '}'
    ].join('\n'));
});

test('a nonnumeric tail permits expansion even when the preview omits it', async () => {
    const text = await render([1, 2, { value: 3 }], { expanded: true, limit: 2 });

    assert.equal(text, '[\n    1,\n    2,\n    \u2026 1 more\n]');
});

test('annotations use Discovery traversal context and surround values', async () => {
    const data = { values: [1, 'two'] };
    const visits: [unknown, ValueAnnotationContext][] = [];
    const { text } = await model.textView.renderString(null, {
        view: 'struct',
        expanded: 2,
        annotations: [
            '#.key = "values" ? { place: "before", style: "badge", text: #.context.label }',
            (value, context) => {
                visits.push([value, context]);
                return typeof value === 'number' && { text: value * 10 };
            }
        ]
    }, data, { label: 'samples' });

    assert.equal(text, '{\n    values: [samples] [\n        1 [10],\n        "two"\n    ]\n}');

    const visit = visits.find(([value]) => value === 1);

    assert.ok(visit);
    const [value, context] = visit;

    assert.equal(value, 1);
    assert.equal(context.host, data.values);
    assert.equal(context.key, 0);
    assert.equal(context.index, 0);
    assert.ok(context.parent);
    assert.equal(context.parent.host, data);
    assert.equal(context.parent.key, 'values');
});

test.each([
    { name: 'array', data: [{ value: 1 }, 2], expected: '[{ value: 1 }, 2] [root]' },
    { name: 'object', data: { value: { nested: 1 } }, expected: '{ value: { nested: 1 } } [root]' }
])('compact $name previews do not evaluate annotations on their entries', async ({ data, expected }) => {
    const visits: unknown[] = [];
    const text = await render(data, {
        limitCompactObjectEntries: false,
        annotations: [(value: unknown) => {
            visits.push(value);
            return { text: 'root' };
        }]
    });

    assert.equal(text, expected);
    assert.deepEqual(visits, [data]);
});

test('an annotation failure is logged without hiding the value or later annotations', async () => {
    const error = new Error('annotation failed');
    const log = vi.spyOn(model.logger, 'error').mockImplementation(() => {});

    try {
        const text = await render(1, {
            annotations: [
                () => {
                    throw error;
                },
                () => ({ text: 'kept' })
            ]
        });

        assert.equal(text, '1 [kept]');
        assert.equal(log.mock.calls.length, 1);
        assert.deepEqual(log.mock.calls[0], ['Text struct annotation error:', error]);
    } finally {
        log.mockRestore();
    }
});

test('recursive previews are bounded without hiding shared siblings or displaying reference labels', async () => {
    const shared = { value: 1 };
    const array: unknown[] = [shared, shared];

    array.push(array);
    const text = await render(array, { limitCompactObjectEntries: false, maxDepth: false });

    assert.equal(text, '[{ value: 1 }, { value: 1 }, [\u2026]]');
});

test('recursive objects follow the requested expansion depth without reference labels', async () => {
    const data = { nested: { self: null as unknown } };

    data.nested.self = data.nested;
    const text = await render(data, { expanded: 3 });

    assert.equal(text, [
        '{',
        '    nested: {',
        '        self: {',
        '            self: { self: {\u2026} }',
        '        }',
        '    }',
        '}'
    ].join('\n'));
});

test('recursive object previews remain bounded with entry and depth limits disabled', async () => {
    const data = { self: null as unknown };

    data.self = data;
    const text = await render(data, { limitCompactObjectEntries: false, maxDepth: false });

    assert.equal(text, '{ self: {\u2026} }');
});

test('a compact array reads only the displayed prefix', async () => {
    const array = new Array(1000000).fill(1);

    Object.defineProperty(array, 4, {
        get() {
            throw new Error('The hidden tail must not be inspected');
        }
    });

    const text = await render(array);

    assert.equal(text, '[1, 1, 1, 1, \u2026 999996 more]');
});

test('typed vectors remain bounded when expanded is requested', async () => {
    const vector = new Uint32Array(1000000);
    const text = await render(vector, { expanded: 10 });

    assert.ok(text.endsWith('[0, 0, 0, 0, \u2026 999996 more]'));
    assert.equal(text.includes('\n'), false);
    assert.ok(text.length < 100);
});

test.each([
    { name: 'array', data: [1, 2] },
    { name: 'typed array', data: new Uint32Array([1, 2]) }
])('$name is read by index without calling its values property', async ({ data }) => {
    Object.defineProperty(data, 'values', {
        get() {
            throw new Error('Array methods must not be accessed');
        }
    });

    const text = await render(data);

    assert.ok(text.endsWith('[1, 2]'));
});

test.each([
    {
        name: 'expanded containers',
        props: { expanded: true, limit: 2 },
        expected: '{\n    first: { one: 1, two: 2 },\n    second: 2,\n    \u2026 1 more\n}'
    },
    {
        name: 'compact previews',
        props: { limitCollapsed: 1, limitCompactObjectEntries: 1 },
        expected: '{ first: { one: 1, \u2026 1 more }, \u2026 2 more }'
    },
    {
        name: 'disabled limits',
        props: { limitCollapsed: false, limitCompactObjectEntries: false },
        expected: '{ first: { one: 1, two: 2 }, second: 2, third: 3 }'
    }
])('limits: $name', async ({ props, expected }) => {
    const data = { first: { one: 1, two: 2 }, second: 2, third: 3 };
    const text = await render(data, props);

    assert.equal(text, expected);
});

test.each([undefined, null, true, '2', -1, NaN, Infinity])('invalid limit %s uses the default', async limit => {
    const text = await render([1, 2, 3, 4, 5], { limitCollapsed: limit });

    assert.equal(text, '[1, 2, 3, 4, \u2026 1 more]');
});

test.each([
    { limit: 0, expected: '[\u2026 3 more]' },
    { limit: 1.9, expected: '[1, \u2026 2 more]' }
])('nonnegative limit $limit is floored', async ({ limit, expected }) => {
    const text = await render([1, 2, 3], { limitCollapsed: limit });

    assert.equal(text, expected);
});

test.each([false, -1, NaN, Infinity, '2'])('invalid or disabled expansion %s stays compact', async expanded => {
    const text = await render({ nested: { value: 1 } }, { expanded });

    assert.equal(text, '{ nested: {\u2026} }');
});

test('fractional expansion depth is floored', async () => {
    const text = await render({ nested: { value: 1 } }, { expanded: 1.9 });

    assert.equal(text, '{\n    nested: { value: 1 }\n}');
});

test.each([
    { value: 'line\n"quoted"\\end', props: {}, expected: '"line\\n\\"quoted\\"\\\\end"' },
    {
        value: 'abcdef',
        props: { maxStringLength: 3, allowedExcessStringLength: 2 },
        expected: '"abc \u2026 3 more"'
    },
    {
        value: 'ab"cdef',
        props: { maxStringLength: 3, allowedExcessStringLength: 0 },
        expected: '"ab\\" \u2026 4 more"'
    },
    {
        value: 'abcde',
        props: { maxStringLength: 3, allowedExcessStringLength: 2 },
        expected: '"abcde"'
    },
    { value: 'abcdef', props: { maxStringLength: false }, expected: '"abcdef"' }
])('string escaping and truncation: $expected', async ({ value, props, expected }) => {
    const text = await render(value, props);

    assert.equal(text, expected);
});

test('compact property and string limits preserve remainder counts', async () => {
    const text = await render({ abcdef: 'abcdef' }, {
        maxCompactPropertyLength: 3,
        maxCompactStringLength: 3,
        allowedExcessStringLength: 0
    });

    assert.equal(text, '{ "abc\u2026": "abc \u2026 3 more" }');
});

test('property names are escaped', async () => {
    const text = await render({ 'line\nkey': 1 });

    assert.equal(text, '{ "line\\nkey": 1 }');
});

test.each([null, undefined, true, false, NaN, Infinity, -Infinity, 12n, Symbol('name')])(
    'scalar %s uses the DOM struct representation',
    async value => {
        const text = await render(value);

        assert.equal(text, String(value));
    }
);

test.each([
    { name: 'function', value: () => {}, expected: '\u0192n' },
    { name: 'regexp', value: /test/gi, expected: '/test/gi' },
    { name: 'date', value: new Date(0), expected: String(new Date(0)) },
    { name: 'invalid date', value: new Date(NaN), expected: 'Invalid Date' },
    { name: 'error', value: new Error('failure'), expected: 'Error: failure' },
    { name: 'compact error', value: [new Error('failure')], expected: '[Error]' }
])('$name uses the DOM struct representation', async ({ value, expected }) => {
    const text = await render(value);

    assert.equal(text, expected);
});

test('objects show own enumerable properties regardless of their prototype', async () => {
    const inherited = Object.assign(Object.create({ inherited: 1 }), { own: 2 });
    const inheritedText = await render(inherited);
    const noPrototypeText = await render(Object.create(null));

    assert.equal(inheritedText, '{ own: 2 }');
    assert.equal(noPrototypeText, '{}');
});

test('sets use sequence limits and bound recursive previews without reference labels', async () => {
    const set = new Set<unknown>(['one', 'two']);

    set.add(set);
    const compactText = await render(set, { limitCollapsed: 2 });
    const expandedText = await render(set, { expanded: true, maxDepth: false });

    assert.ok(compactText.endsWith('["one", "two", \u2026 1 more]'));
    assert.ok(expandedText.endsWith('[\n    "one",\n    "two",\n    ["one", "two", [\u2026]]\n]'));
});

test('deeply nested compact arrays stop at an explicit depth boundary', async () => {
    let data: unknown = 1;

    for (let depth = 0; depth < 10000; depth++) {
        data = [data];
    }

    const text = await render(data);

    assert.ok(text.includes('[Depth limit]'));
    assert.ok(text.length < 200);
});

test('the depth boundary can be configured or disabled', async () => {
    const limitedText = await render([[1]], { maxDepth: 1 });
    const unlimitedText = await render([[1]], { maxDepth: false });

    assert.equal(limitedText, '[[Depth limit]]');
    assert.equal(unlimitedText, '[[1]]');
});

test('model markers are reused without changing the input object', async () => {
    const data = { id: 1, name: 'sample' };
    const markedModel = new Model({
        setup({ defineObjectMarker }) {
            const mark = defineObjectMarker('item', { ref: 'id', title: 'name' });

            mark(data);
        }
    });

    defineStruct(markedModel);
    const { text } = await markedModel.textView.renderString(null, 'struct', data);
    const collapsed = await markedModel.textView.renderString(null, 'struct', [data]);
    const expanded = await markedModel.textView.renderString(null, { view: 'struct', expanded: true }, [data]);

    assert.equal(text, '[item] { id: 1, name: "sample" }');
    assert.equal(collapsed.text, '[{\u2026}]');
    assert.equal(expanded.text, '[\n    [item] { id: 1, name: "sample" }\n]');
    assert.deepEqual(data, { id: 1, name: 'sample' });
});

test('struct composes with native data, context, conditions and adjacent text', async () => {
    const config = {
        view: 'struct',
        when: 'enabled',
        context: '{ ...#, depth: 2 }',
        data: 'value',
        whenData: '$',
        expanded: '=#.depth'
    };
    const data = { enabled: true, value: { nested: { value: 1 } } };
    const { text } = await model.textView.renderString(null, [
        { view: node => node.appendText('before ') },
        config,
        { view: node => node.appendText(' after') }
    ], data, {});
    const skippedBeforeData = await model.textView.renderString(null, config, { ...data, enabled: false });
    const skippedAfterData = await model.textView.renderString(null, config, { enabled: true, value: null });

    assert.equal(text, 'before {\n    nested: {\n        value: 1\n    }\n} after');
    assert.equal(skippedBeforeData.text, '');
    assert.equal(skippedAfterData.text, '');
});
