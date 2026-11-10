import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SourceMapConsumer, SourceMapGenerator } from 'source-map-js';
import { DecodedSourceMap } from './source-map.js';
import type { SourceMap } from '../types.js';

function originalPositionFor(decoded: DecodedSourceMap, line: number, column: number) {
    const segment = decoded.findSegment(line, column);
    const sourceIndex = segment !== -1 ? decoded.sourceIndexes[segment] : -1;

    return sourceIndex !== -1
        ? { source: decoded.sources[sourceIndex], line: decoded.originalLines[segment] + 1, column: decoded.originalColumns[segment] }
        : { source: null, line: null, column: null };
}

test('resolves generated positions as source-map-js does', () => {
    let seed = 1;
    const random = (max: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % max;
    const generator = new SourceMapGenerator({ file: 'bundle.js' });

    for (let line = 1; line <= 40; line++) {
        for (let column = random(5); column < 200; column += 1 + random(30)) {
            if (random(10) === 0) {
                generator.addMapping({ generated: { line, column } } as Parameters<typeof generator.addMapping>[0]);
            } else {
                generator.addMapping({
                    generated: { line, column },
                    original: { line: 1 + random(100), column: random(80) },
                    source: `./src/../src/file-${random(4)}.js`,
                    name: random(2) ? 'name' : undefined
                } as Parameters<typeof generator.addMapping>[0]);
            }
        }
    }

    const sourceMap: SourceMap = JSON.parse(generator.toString());
    const decoded = new DecodedSourceMap(sourceMap);
    const consumer = new SourceMapConsumer(sourceMap as ConstructorParameters<typeof SourceMapConsumer>[0]);

    for (let line = 0; line <= 41; line++) {
        for (let column = 0; column < 220; column++) {
            const expected = consumer.originalPositionFor({ line: line + 1, column });

            assert.deepEqual(originalPositionFor(decoded, line, column), {
                source: expected.source,
                line: expected.line,
                column: expected.column
            }, `${line}:${column}`);
        }
    }
});

test('sorts unsorted segments of a line and resolves sources against the source root', () => {
    const decoded = new DecodedSourceMap({
        version: '3',
        file: 'bundle.js',
        sourceRoot: 'webpack://app/',
        sources: ['./a.js', 'b/../b.js'],
        sourcesContent: ['a', null],
        names: [],
        // line 0: column 10 → a.js 0:0, column 4 → b.js 1:2 (unsorted); line 2: column 0 → b.js 1:3
        mappings: 'UAAA,NCCE;;AAAC'
    });

    assert.deepEqual(decoded.sources, ['webpack://app/a.js', 'webpack://app/b.js']);
    assert.deepEqual([...decoded.lineStarts], [0, 2, 2, 3]);
    assert.deepEqual([...decoded.columns], [4, 10, 0]);
    assert.deepEqual([...decoded.sourceIndexes], [1, 0, 1]);
    assert.equal(decoded.findSegment(0, 3), -1);
    assert.equal(decoded.findSegment(0, 9), 0);
    assert.equal(decoded.findSegment(0, 100), 1);
    assert.equal(decoded.findSegment(1, 0), -1);
    assert.equal(decoded.findSegment(2, 5), 2);
    assert.equal(decoded.findSegment(3, 0), -1);
    assert.deepEqual([decoded.originalLines[2], decoded.originalColumns[2]], [1, 3]);
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
    const decoded = new DecodedSourceMap(sourceMap);
    const consumer = new SourceMapConsumer(sourceMap as ConstructorParameters<typeof SourceMapConsumer>[0]);

    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 6; j++) {
            const expected = consumer.originalPositionFor({
                line: i + 1,
                column: j
            });

            assert.deepEqual(originalPositionFor(decoded, i, j), {
                source: expected.source,
                line: expected.line,
                column: expected.column
            }, `${i}:${j}`);
        }
    }

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
