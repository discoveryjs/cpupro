import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SourceMapConsumer, SourceMapGenerator } from 'source-map-js';
import { DecodedSourceMap } from './source-map.js';
import type { SourceMap } from '../types.js';

function originalPositionFor(decoded: DecodedSourceMap, line: number, column: number) {
    const segment = decoded.findSegment(line, column);
    const sourceIndex = segment !== -1 ? decoded.sourceIndexes[segment] : -1;

    if (sourceIndex === -1) {
        return { source: null, line: null, column: null };
    }

    return {
        source: decoded.sources[sourceIndex],
        line: decoded.originalLines[segment] + 1,
        column: decoded.originalColumns[segment]
    };
}

// Positions of the generated lines and columns resolve as source-map-js resolves them
function assertConsumerPositions(sourceMap: SourceMap, lineCount: number, columnCount: number) {
    const decoded = new DecodedSourceMap(sourceMap);
    const consumer = new SourceMapConsumer(sourceMap as ConstructorParameters<typeof SourceMapConsumer>[0]);

    for (let i = 0; i < lineCount; i++) {
        for (let j = 0; j < columnCount; j++) {
            const expected = consumer.originalPositionFor({ line: i + 1, column: j });

            assert.deepEqual(originalPositionFor(decoded, i, j), {
                source: expected.source,
                line: expected.line,
                column: expected.column
            }, `${i}:${j}`);
        }
    }

    return decoded;
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

// Segments are given as [generated column, source index, original line, original column]
test.each([
    {
        name: 'the first line',
        // line 0: column 10 → a.js 0:0, column 4 → b.js 1:2; line 2: column 0 → b.js 1:3
        mappings: 'UAAA,NCCE;;AAAC',
        lineStarts: [0, 2, 2, 3],
        segments: [[4, 1, 1, 2], [10, 0, 0, 0], [0, 1, 1, 3]]
    },
    {
        name: 'a line between other lines',
        // line 0: columns 0 and 1 → a.js 0:0; line 1: column 10 → a.js 0:0, column 4 → b.js 1:2;
        // line 2: column 0 → b.js 1:2
        mappings: 'AAAA,CAAA;UAAA,NCCE;AAAA',
        lineStarts: [0, 2, 4, 5],
        segments: [[0, 0, 0, 0], [1, 0, 0, 0], [4, 1, 1, 2], [10, 0, 0, 0], [0, 1, 1, 2]]
    },
    {
        name: 'the last line',
        // line 0: column 0 → a.js 0:0; line 1: column 10 → a.js 0:0, column 4 → b.js 1:2
        mappings: 'AAAA;UAAA,NCCE',
        lineStarts: [0, 1, 3],
        segments: [[0, 0, 0, 0], [4, 1, 1, 2], [10, 0, 0, 0]]
    }
])('sorts unsorted segments of $name by generated column', row => {
    const { mappings, lineStarts, segments } = row;
    const decoded = new DecodedSourceMap(createSourceMap(undefined, ['a.js', 'b.js'], mappings));
    const describeSegment = (_: unknown, segment: number) => [
        decoded.columns[segment],
        decoded.sourceIndexes[segment],
        decoded.originalLines[segment],
        decoded.originalColumns[segment]
    ];

    assert.deepEqual([...decoded.lineStarts], lineStarts);
    // Vectors hold a slot per segment
    assert.equal(decoded.columns.length, segments.length);
    assert.deepEqual(segments.map(describeSegment), segments);
});

test.each([
    { line: 0, column: 3, segment: -1 },
    { line: 0, column: 4, segment: 0 },
    { line: 0, column: 9, segment: 0 },
    { line: 0, column: 10, segment: 1 },
    { line: 0, column: 100, segment: 1 },
    { line: 1, column: 0, segment: -1 },
    { line: 2, column: 5, segment: 3 },
    { line: 3, column: 0, segment: -1 }
])('line $line, column $column is in segment $segment, the first of the segments at the same column', row => {
    // line 0: columns 4, 10 and 10 again; line 1 is empty; line 2: column 0
    const decoded = new DecodedSourceMap(createSourceMap(undefined, ['a.js'], 'IAAA,MAAC,AAAC;;KAAC'));

    assert.equal(decoded.findSegment(row.line, row.column), row.segment);
});

test('sources resolve against the source root, missing contents are none', () => {
    const sourceMap = {
        ...createSourceMap('webpack://app/', ['./a.js', 'b/../b.js'], 'AAAA'),
        sourcesContent: undefined
    } as SourceMap;
    const decoded = new DecodedSourceMap(sourceMap);

    assert.deepEqual(decoded.sources, ['webpack://app/a.js', 'webpack://app/b.js']);
    assert.deepEqual(decoded.sourcesContent, []);
});

const invalidMappings = ['AA!A', 'AA\u0080A'];

test.each(invalidMappings)('invalid mappings %s are rejected at the position of the invalid character', mappings => {
    const decode = () => new DecodedSourceMap(createSourceMap(undefined, ['a.js'], mappings));

    assert.throws(decode, /Invalid character in source map mappings at 2$/);
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
    const decoded = assertConsumerPositions(sourceMap, 3, 6);

    assert.deepEqual(originalPositionFor(decoded, 0, 0), {
        source: 'a.js',
        line: 1,
        column: 2
    });
    assert.deepEqual(originalPositionFor(decoded, 1, 0), {
        source: 'a.js',
        line: 1,
        column: 2
    });
    assert.deepEqual(originalPositionFor(decoded, 2, 4), {
        source: 'a.js',
        line: 2,
        column: 2
    });
});
