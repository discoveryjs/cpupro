import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SourceMapConsumer, SourceMapGenerator } from 'source-map-js';
import { SourceMapIndex } from './source-map.js';
import type { SourceMap } from '../types.js';
import { sequence } from '../../../test/helpers/values.js';

function originalPositionFor(index: SourceMapIndex, line: number, column: number) {
    const originalPosition = index.findOriginalPosition(line, column);

    if (originalPosition === null) {
        return { source: null, line: null, column: null };
    }

    return {
        source: index.sources[originalPosition.source],
        line: originalPosition.line + 1,
        column: originalPosition.column
    };
}

// Positions of the generated lines and columns resolve as source-map-js resolves them
function assertConsumerPositions(sourceMap: SourceMap, lineCount: number, columnCount: number) {
    const index = new SourceMapIndex(sourceMap);
    const consumer = new SourceMapConsumer(sourceMap as ConstructorParameters<typeof SourceMapConsumer>[0]);

    for (let i = 0; i < lineCount; i++) {
        for (let j = 0; j < columnCount; j++) {
            const expected = consumer.originalPositionFor({ line: i + 1, column: j });

            assert.deepEqual(originalPositionFor(index, i, j), {
                source: expected.source,
                line: expected.line,
                column: expected.column
            }, `${i}:${j}`);
        }
    }

    return index;
}

function createSourceMap(sourceRoot: string | undefined, sources: string[], mappings: string): SourceMap {
    return {
        version: '3',
        file: 'bundle.js',
        sourceRoot,
        sources,
        sourcesContent: sources.map(() => null),
        names: [],
        mappings
    } as SourceMap;
}

test.each([
    {
        name: 'without a source root',
        sourceRoot: undefined,
        source: './src/../src/file-'
    },
    {
        name: 'without a source root and absolute sources',
        sourceRoot: undefined,
        source: '/src/file-'
    },
    {
        name: 'with a URL source root',
        sourceRoot: 'webpack://app/',
        source: './src/file-'
    },
    {
        name: 'with an absolute source root and absolute sources',
        sourceRoot: '/root/',
        source: '/root/src/file-'
    },
    {
        name: 'with an absolute source root and sources elsewhere',
        sourceRoot: '/root/',
        source: '/other/file-'
    },
    {
        name: 'with an absolute source root and relative sources',
        sourceRoot: '/root/',
        source: './src/file-'
    }
])('resolves generated positions as source-map-js does $name', row => {
    const { sourceRoot, source } = row;
    let seed = 1;
    const random = (max: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % max;
    const generator = new SourceMapGenerator({ file: 'bundle.js' });

    for (let i = 1; i <= 40; i++) {
        for (let j = random(5); j < 200; j += 1 + random(30)) {
            const generated = { line: i, column: j };

            if (random(10) === 0) {
                generator.addMapping({ generated } as Parameters<typeof generator.addMapping>[0]);
            } else {
                generator.addMapping({
                    generated,
                    original: { line: 1 + random(100), column: random(80) },
                    source: `${source}${random(4)}.js`,
                    name: random(2) ? 'name' : undefined
                } as Parameters<typeof generator.addMapping>[0]);
            }
        }
    }

    // The source root is set after generation, so the generator doesn't rewrite the sources against it
    const sourceMap: SourceMap = { ...JSON.parse(generator.toString()), sourceRoot };

    // Two lines past the generated ones
    assertConsumerPositions(sourceMap, 42, 220);
});

test.each([
    {
        name: 'the first line',
        // line 0: column 10 → a.js 0:0, column 4 → b.js 1:2; line 2: column 0 → b.js 1:3
        mappings: 'UAAA,NCCE;;AAAC'
    },
    {
        name: 'a line between other lines',
        // line 0: columns 0 and 1 → a.js 0:0; line 1: column 10 → a.js 0:0, column 4 → b.js 1:2;
        // line 2: column 0 → b.js 1:2
        mappings: 'AAAA,CAAA;UAAA,NCCE;AAAA'
    },
    {
        name: 'the last line',
        // line 0: column 0 → a.js 0:0; line 1: column 10 → a.js 0:0, column 4 → b.js 1:2
        mappings: 'AAAA;UAAA,NCCE'
    }
])('resolves positions on unsorted segments of $name as source-map-js does', row => {
    assertConsumerPositions(createSourceMap(undefined, ['a.js', 'b.js'], row.mappings), 4, 12);
});

test('resolves positions on lines of many segments as source-map-js does', () => {
    const random = sequence(1);
    const generator = new SourceMapGenerator({ file: 'bundle.js' });

    // Long lines with runs of segments at the same column, some of them without an original position
    for (let i = 1; i <= 3; i++) {
        for (let j = 0; j < 300; j += random(3)) {
            const generated = { line: i, column: j };

            if (random(8) === 0) {
                generator.addMapping({ generated } as Parameters<typeof generator.addMapping>[0]);
            } else {
                generator.addMapping({
                    generated,
                    original: { line: 1 + random(20), column: random(40) },
                    source: `file-${random(3)}.js`
                } as Parameters<typeof generator.addMapping>[0]);
            }
        }
    }

    assertConsumerPositions(JSON.parse(generator.toString()), 4, 310);
});

const noPosition = { source: null, line: null, column: null };
const positionInA = (column: number) => ({ source: 'a.js', line: 1, column });

test.each([
    { line: 0, column: 3, original: noPosition },
    { line: 0, column: 4, original: positionInA(0) },
    { line: 0, column: 9, original: positionInA(0) },
    { line: 0, column: 10, original: positionInA(1) },
    { line: 0, column: 100, original: positionInA(1) },
    { line: 1, column: 0, original: noPosition },
    { line: 2, column: 5, original: positionInA(3) },
    { line: 3, column: 0, original: noPosition }
])('line $line, column $column resolves to the first of the segments at the rightmost column before it', row => {
    // line 0: column 4 → a.js 0:0, column 10 → a.js 0:1, column 10 again → a.js 0:2; line 1 is empty;
    // line 2: column 0 → a.js 0:3
    const index = new SourceMapIndex(createSourceMap(undefined, ['a.js'], 'IAAA,MAAC,AAAC;;KAAC'));

    assert.deepEqual(originalPositionFor(index, row.line, row.column), row.original);
});

test('sources resolve against the source root, missing contents are none', () => {
    const sourceMap = {
        ...createSourceMap('webpack://app/', ['./a.js', 'b/../b.js'], 'AAAA'),
        sourcesContent: undefined
    } as SourceMap;
    const index = new SourceMapIndex(sourceMap);

    assert.deepEqual(index.sources, ['webpack://app/a.js', 'webpack://app/b.js']);
    assert.deepEqual(index.sourcesContent, []);
});

test.each([
    { mappings: 'AA!A', offset: 2 },
    { mappings: 'AA\u0080A', offset: 2 },
    // a value with the continuation bit ends with the mappings
    { mappings: 'AAg', offset: 3 }
])('invalid mappings $mappings are rejected at the position of the invalid character', row => {
    const index = () => new SourceMapIndex(createSourceMap(undefined, ['a.js'], row.mappings));

    assert.throws(index, new RegExp(`Invalid character in source map mappings at ${row.offset}$`));
});

test('resolves segments at an equal generated column as source-map-js does', () => {
    const sourceMap: SourceMap = {
        version: '3',
        file: 'bundle.js',
        sources: ['a.js', 'b.js'],
        names: [],
        // line 0, column 0: no original position, b.js 0:0, a.js 0:2; line 1, column 0: a.js 0:3, a.js 0:2;
        // line 2, column 4: a.js 1:2, no original position
        mappings: 'A,ACAA,ADAE;AAAC,AAAD;IACA,A'
    };
    const index = assertConsumerPositions(sourceMap, 3, 6);

    assert.deepEqual(originalPositionFor(index, 0, 0), {
        source: 'a.js',
        line: 1,
        column: 2
    });
    assert.deepEqual(originalPositionFor(index, 1, 0), {
        source: 'a.js',
        line: 1,
        column: 2
    });
    assert.deepEqual(originalPositionFor(index, 2, 4), {
        source: 'a.js',
        line: 2,
        column: 2
    });
});
