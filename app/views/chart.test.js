import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';
import { setRangeCoverage } from './misc/range-coverage.js';
import usage from './chart.usage.js';

function createElement() {
    return {
        children: [], attributes: new Map(), styles: new Map(), classList: new Set(),
        style: { setProperty() {} },
        setAttribute(name, value) {
            this.attributes.set(name, value);
        },
        append(...children) {
            this.children.push(...children);
        }
    };
}

let renderChart;

const generateCurve = runInNewContext(
    readFileSync(new URL('./chart.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '') + '\ngenerateCurve;',
    {
        discovery: { view: { define(name, render) {
            renderChart = render;
        } } },
        usage, setRangeCoverage,
        document: { createElement, createElementNS: createElement }
    }
);

test('uses point bounds by default and caller-supplied minX/maxX independently of context', () => {
    for (const [config, minX, maxX] of [
        [{}, 120, 180],
        [{ minX: 100, maxX: 200 }, 100, 200],
        [{ minX: 110, maxX: 190 }, 110, 190],
        [{ minX: 100 }, 100, 180],
        [{ maxX: 200 }, 120, 200]
    ]) {
        for (const context of [{}, { scopeViewport: { start: 0, end: 1000 } }]) {
            const element = createElement();
            const extent = { start: 110, end: 190 };
            renderChart(element, {
                ...config, extent, height: 100,
                points: [{ x: 120, y: 10 }, { x: 180, y: 20 }]
            }, null, context);
            const svg = element.children.at(-1);
            const curve = svg.children.at(-1).attributes.get('d');
            assert.equal(curve, generateCurve([120, 180], [10, 20], 100, minX, maxX, 10, 20, false, extent));
        }
    }
});

test.each([false, true])('extends the curve to coverage edges on the viewport scale, line=%s', line => {
    const extent = { start: 110, end: 190 };
    const curve = generateCurve([120, 150, 180], [10, 20, 15], 100, 100, 200, 10, 20, line, extent);

    assert.ok(curve.startsWith('M 100 '));
    assert.ok(curve.includes('H 200 '));
    assert.ok(curve.includes('L 500 '));
    assert.ok(line ? curve.endsWith('H 900') : /L 900 [\d.]+ V [\d.]+ Z$/.test(curve));
    const styles = new Map();
    const element = { classList: new Set(), style: { setProperty: (key, value) => styles.set(key, value) } };
    setRangeCoverage(element, extent, { start: 100, end: 200 });
    assert.equal(styles.get('--range-pad-start'), 0.1);
    assert.equal(styles.get('--range-pad-end'), 0.1);
    assert.ok(element.classList.has('range-coverage'));
});

test('retains coordinates outside a narrower viewport for SVG clipping, not rescaling', () => {
    const curve = generateCurve([120, 150, 180], [10, 20, 15], 100, 140, 160, 10, 20, true, { start: 110, end: 190 });

    assert.ok(curve.startsWith('M -1500 '));
    assert.ok(curve.includes('H -1000 '));
    assert.ok(curve.includes('L 500 '));
    assert.ok(curve.endsWith('H 2500'));
});

test.each([false, true])('does not extend a recording into a non-overlapping viewport, line=%s', line => {
    const curve = generateCurve([120, 150, 180], [10, 20, 15], 100, 200, 300, 10, 20, line, { start: 110, end: 190 });

    assert.ok(curve.startsWith('M -900 '));
    assert.ok(line ? curve.endsWith('H -100') : /L -100 [\d.]+ V [\d.]+ Z$/.test(curve));
});

test('uses the viewport as coverage when no extent is supplied', () => {
    const curve = generateCurve([120, 150, 180], [10, 20, 15], 100, 100, 200, 10, 20, true);

    assert.ok(curve.startsWith('M 0 '));
    assert.ok(curve.endsWith('H 1000'));
});
