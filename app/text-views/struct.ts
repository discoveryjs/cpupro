import type { Model } from '@discoveryjs/discovery/lib/main/model.js';
import {
    getDefaultAnnotations,
    prepareAnnotations,
    type ValueAnnotation,
    type ValueAnnotationContext
} from '@discoveryjs/discovery/lib/views/struct/render-annotations.js';

// Discovery does not export RenderBox yet; derive it from the public render method.
type RenderBox = Awaited<ReturnType<Model['textView']['render']>>;
type TypedArray = ArrayBufferView & ArrayLike<number | bigint>;
type StructOptions = typeof defaults & {
    expanded: number;
    annotations: unknown[];
};
type Container = {
    kind: 'array';
    size: number;
    value: ArrayLike<unknown>;
} | {
    kind: 'set';
    size: number;
    values: Iterator<unknown>;
} | {
    kind: 'object';
    value: Record<string, unknown>;
    keys: string[];
};
type TextAnnotation = {
    text?: unknown;
    place?: unknown;
    style?: unknown;
};

const defaults = {
    limit: 50,
    limitCollapsed: 4,
    limitCompactObjectEntries: 0,
    maxStringLength: 150,
    maxCompactStringLength: 40,
    allowedExcessStringLength: 10,
    maxPropertyLength: Infinity,
    maxCompactPropertyLength: 35,
    maxDepth: 64
};

function normalizeProps(data: unknown, { props }: { props: Record<string, unknown> }): StructOptions {
    const options: StructOptions = {
        ...defaults,
        expanded: 0,
        annotations: Array.isArray(props.annotations) ? props.annotations : []
    };

    for (const name of Object.keys(defaults) as (keyof typeof defaults)[]) {
        const value = props[name];

        if (value === false) {
            options[name] = Infinity;
        } else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            options[name] = Math.floor(value);
        }
    }

    if (props.expanded === true) {
        options.expanded = 1;
    } else if (typeof props.expanded === 'number' && Number.isFinite(props.expanded)) {
        options.expanded = Math.max(0, Math.floor(props.expanded));
    }

    return options;
}

function propertyText(key: string, limit: number) {
    const name = key.length > limit ? key.slice(0, limit) + '\u2026' : key;

    return /^[\w$]+$/.test(name) ? name : JSON.stringify(name);
}

function formatAnnotation(value: unknown) {
    const annotation = Object(value) as TextAnnotation;
    let text = '';

    if (annotation.text !== undefined) {
        text = String(annotation.text);
    } else if (typeof value !== 'object') {
        text = String(value);
    }

    const before = annotation.place === 'before';
    const badge = annotation.style === 'badge' || (annotation.style !== 'none' && !before);

    if (text !== '') {
        text = JSON.stringify(text).slice(1, -1);

        if (badge) {
            text = `[${text}]`;
        }
    }

    return { text, before };
}

function isNumericArray(value: readonly unknown[]) {
    // Match DOM struct: a nonnumeric value anywhere permits expansion, even past the preview limit.
    // Like Array#every, skip holes. Typed arrays bypass this potentially full scan.
    for (let index = 0; index < value.length; index++) {
        if (index in value && typeof value[index] !== 'number') {
            return false;
        }
    }

    return true;
}

function renderStruct(host: Model, root: RenderBox, options: StructOptions, data: unknown, outerContext: unknown) {
    const activeContainers = new Set<object>();
    let depth = 0;

    // Discovery types this helper as ViewModel, but it only uses Model.objectMarkers.
    const defaultAnnotations = (getDefaultAnnotations as (host: Model) => ValueAnnotation[] | false)(host);
    const annotations = prepareAnnotations(options.annotations, defaultAnnotations || []) || [];

    function render(node: RenderBox, value: unknown, expanded: number, compact: boolean, context: ValueAnnotationContext) {
        // HTML struct annotates standalone values, not entries inside compact previews.
        if (compact) {
            renderValue(node, value, expanded, compact, context);
            return;
        }

        const after: string[] = [];

        for (const { query, debug } of annotations) {
            try {
                const queryContext = { ...context, context: outerContext };
                const annotation: unknown = host.query(query, value, queryContext);

                if (debug) {
                    host.logger.info('Compute text struct annotation', {
                        data: value,
                        context: queryContext,
                        query,
                        queryResult: annotation
                    });
                }

                if (annotation) {
                    const { text, before } = formatAnnotation(annotation);

                    if (text !== '') {
                        if (before) {
                            node.appendText(text + ' ');
                        } else {
                            after.push(text);
                        }
                    }
                }
            } catch (error) {
                host.logger.error('Text struct annotation error:', error);
            }
        }

        renderValue(node, value, expanded, compact, context);

        for (const text of after) {
            node.appendText(' ' + text);
        }
    }

    function renderString(node: RenderBox, value: string, compact: boolean) {
        const limit = compact ? options.maxCompactStringLength : options.maxStringLength;
        const shortened = value.length > limit + options.allowedExcessStringLength;

        if (shortened) {
            node.appendText(JSON.stringify(`${value.slice(0, limit)} \u2026 ${value.length - limit} more`));
        } else {
            node.appendText(JSON.stringify(value));
        }
    }

    function renderValue(
        node: RenderBox,
        value: unknown,
        expanded: number,
        compact: boolean,
        context: ValueAnnotationContext
    ) {
        if (typeof value === 'string') {
            renderString(node, value, compact);
            return;
        }

        if (typeof value !== 'object' || value === null) {
            node.appendText(typeof value === 'function' ? '\u0192n' : String(value));
            return;
        }

        const tag = Object.prototype.toString.call(value);

        if (tag === '[object Date]' || tag === '[object RegExp]') {
            node.appendText(String(value));
            return;
        }

        if (tag === '[object Error]') {
            node.appendText(compact ? String((value as Error).name) : String(value));
            return;
        }

        if (depth >= options.maxDepth) {
            node.appendText('[Depth limit]');
            return;
        }

        let container: Container;

        if (Array.isArray(value)) {
            container = {
                kind: 'array',
                size: value.length,
                value
            };

            if (expanded > 0 && isNumericArray(value)) {
                expanded = 0;
            }
        } else if (ArrayBuffer.isView(value) && tag !== '[object DataView]') {
            const vector = value as TypedArray;

            container = {
                kind: 'array',
                size: vector.length,
                value: vector
            };
            expanded = 0;
        } else if (tag === '[object Set]') {
            const set = value as Set<unknown>;

            container = {
                kind: 'set',
                size: set.size,
                values: set.values()
            };
        } else {
            if (compact && options.limitCompactObjectEntries === 0) {
                // An opaque preview only needs to know whether an own property exists.
                for (const key in value) {
                    if (Object.hasOwn(value, key)) {
                        node.appendText('{\u2026}');
                        return;
                    }
                }

                node.appendText('{}');
                return;
            }

            container = {
                kind: 'object',
                value: value as Record<string, unknown>,
                keys: Object.keys(value)
            };
        }

        // Expansion is depth-bounded; compact previews also need a recursion guard.
        // Keep shared siblings renderable and do not expose reference identities in the text.
        const wasActive = activeContainers.has(value);

        if (compact && wasActive) {
            node.appendText(container.kind === 'object' ? '{\u2026}' : '[\u2026]');
            return;
        }

        activeContainers.add(value);
        depth++;
        renderContainer(node, container, value, expanded, compact, context);
        depth--;

        if (!wasActive) {
            activeContainers.delete(value);
        }
    }

    function renderContainer(
        node: RenderBox,
        container: Container,
        value: object,
        expanded: number,
        compact: boolean,
        context: ValueAnnotationContext
    ) {
        const size = container.kind === 'object' ? container.keys.length : container.size;
        const multiline = expanded > 0 && size > 0;
        const open = container.kind === 'object' ? '{' : '[';
        const close = container.kind === 'object' ? '}' : ']';
        let limit = options.limitCollapsed;

        if (multiline) {
            limit = options.limit;
        } else if (compact && container.kind === 'object') {
            limit = options.limitCompactObjectEntries;
        }

        const count = Math.min(size, limit);

        node.appendText(open);

        const content = multiline ? node.appendLine() : node;

        if (multiline) {
            content.setBorder({ left: '    ' });
        } else if (container.kind === 'object' && size > 0) {
            node.appendText(' ');
        }

        for (let index = 0; index < count; index++) {
            const entry = multiline ? content.appendLine() : content;
            let key: string | number = index;
            let child: unknown;

            if (!multiline && index > 0) {
                entry.appendText(', ');
            }

            if (container.kind === 'object') {
                key = container.keys[index];
                child = container.value[key];

                const propertyLimit = multiline ? options.maxPropertyLength : options.maxCompactPropertyLength;

                entry.appendText(propertyText(key, propertyLimit) + ': ');
            } else if (container.kind === 'array') {
                child = container.value[index];
            } else {
                child = container.values.next().value;
            }

            render(entry, child, multiline ? expanded - 1 : 0, !multiline, {
                parent: context,
                host: value,
                key,
                index
            });

            if (multiline && index < size - 1) {
                entry.appendText(',');
            }
        }

        if (count < size) {
            const more = multiline ? content.appendLine() : content;

            if (!multiline && count > 0) {
                more.appendText(', ');
            }

            more.appendText(`\u2026 ${size - count} more`);
        }

        // Append to the parent so its comma or following text stays on the closing line.
        node.appendText(!multiline && container.kind === 'object' && size > 0 ? ' ' + close : close);
    }

    render(root, data, options.expanded, false, {
        parent: null,
        host: { '': data },
        key: '',
        index: 0
    });
}

export default function(host: Model) {
    host.textView.define('struct', {
        type: 'inline',
        usage: undefined,
        props: normalizeProps,
        render(node, options: StructOptions, data: unknown, context: unknown) {
            renderStruct(host, node, options, data, context);
        }
    });
}
