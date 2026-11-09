import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveScopeProfileLine, resolveScopeViewport } from '../jora/profile.js';
import { lineViewport } from '../jora/viewport.js';
import { createLineFixture } from '../../test/fixtures/profile.js';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';

function createElement(tagName, className) {
    const element = {
        tagName, className, children: [], styles: new Map(),
        style: { setProperty: (name, value) => element.styles.set(name, value) },
        append(...children) {
            element.children.push(...children);
        }
    };

    return element;
}

function render(config, data, context) {
    let renderIntervals;
    let lifecycle;

    evaluateModule(new URL('./line-intervals.js', import.meta.url), {
        resolveScopeProfileLine, resolveScopeViewport, lineViewport,
        utils: { createElement },
        discovery: { view: { define: (_, callback) => renderIntervals = callback } },
        HTMLElement: class {},
        customElements: { define: (name, Element) => lifecycle = { name, Element } }
    });

    const el = createElement('div');

    renderIntervals(el, config, data, context);
    assert.equal(lifecycle.name, 'destroy-line-intervals');

    return el;
}

const styles = el => el.children
    .filter(child => child.className === 'interval')
    .map(child => Object.fromEntries(child.styles));

test('places intervals overlapping the range as fractions of it', async () => {
    const { line } = await createLineFixture({ origin: 100, values: new Uint32Array([100]) });
    const intervals = [
        { start: 80, end: 100, color: 'a' },
        { start: 90, end: 110, color: 'b' },
        { start: 150, end: 175, color: 'c' },
        { start: 190, end: 250, color: 'd' },
        { start: 200, end: 210, color: 'e' }
    ];
    const el = render({}, intervals, { scopeLine: line, scopeViewport: { start: 100, end: 200 } });

    assert.deepEqual(styles(el), [
        { '--start': -0.1, '--end': 0.1, '--color': 'b' },
        { '--start': 0.5, '--end': 0.75, '--color': 'c' },
        { '--start': 0.9, '--end': 1.5, '--color': 'd' }
    ]);
    assert.equal(el.children.length, 3);
    assert.deepEqual(styles(render({}, null, { scopeLine: line })), []);
});

test('zoom displays the line viewport within the range until destroyed', async () => {
    const { line } = await createLineFixture({ origin: 100, values: new Uint32Array([100]) });
    const el = render({ zoom: true }, [{ start: 150, end: 160, color: 'a' }], {
        scopeLine: line, scopeViewport: { start: 100, end: 200 }
    });
    const destroyEl = el.children.at(-1);

    assert.equal(destroyEl.tagName, 'destroy-line-intervals');
    line.viewport.selection.setRange(120, 145);
    assert.equal(el.styles.size, 0);
    destroyEl.onConnect();
    assert.deepEqual(Object.fromEntries(el.styles), { '--display-start': 0.2, '--display-scale': 4 });
    line.viewport.resetRange();
    assert.deepEqual(Object.fromEntries(el.styles), { '--display-start': 0, '--display-scale': 1 });
    destroyEl.onDestroy();
    line.viewport.selection.setRange(120, 145);
    assert.deepEqual(Object.fromEntries(el.styles), { '--display-start': 0, '--display-scale': 1 });
    line.viewport.resetRange();
});
