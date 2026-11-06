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
