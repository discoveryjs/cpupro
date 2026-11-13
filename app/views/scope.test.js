import assert from 'node:assert/strict';
import { test } from 'vitest';
import { evaluateModule } from '../../test/helpers/evaluate-module.js';
import { createElement } from '../../test/helpers/dom.js';
import { createSessionFixture } from '../../test/fixtures/profile.js';
import { createRootScope, deriveScope, missingScopeElement } from '../jora/scope.js';

function loadView() {
    let render;

    evaluateModule(new URL('./scope.js', import.meta.url), {
        discovery: { view: { define: (_, fn) => render = fn } },
        deriveScope,
        missingScopeElement
    });

    return render;
}

// Renders the view into an element: what the view renders is recorded as its children `{ config, data, context }`,
// so rendering again after a choice replaces them
function renderView(config, context) {
    const el = createElement('div');
    const host = {
        render: (target, renderConfig, renderData, renderContext) => target.append({
            config: renderConfig,
            data: renderData,
            context: renderContext
        })
    };

    loadView().call(host, el, config, null, context);

    return el;
}

// The parts of a choice the view renders: its message and its select
function choiceParts(rendered) {
    const [message, select] = rendered.config;

    return { message: message.content, select };
}

const config = {
    requires: 'breakdown',
    content: 'text:"content"'
};

test('the content gets the scope, in the flat scope fields too, when the elements are selected', async () => {
    const { session, first } = await createSessionFixture();
    const scope = createRootScope([session], first, 'memline', 'location');
    const el = renderView(config, { scope });
    const [content] = el.children;

    assert.equal(el.children.length, 1);
    assert.equal(content.config, 'text:"content"');
    assert.equal(content.context.scope, scope);
    assert.equal(content.context.scopeProfile, first);
    assert.equal(content.context.scopeLine, first.memline);
    assert.equal(content.context.scopeBreakdown, scope.breakdown);
});

test('a requested element the data lacks is chosen from the choices of the data, a single one too', async () => {
    const { session, cpuOnly } = await createSessionFixture();
    const scope = createRootScope([session], cpuOnly, 'memline', 'call-stack');
    const el = renderView(config, { scope });
    const [choice] = el.children;
    const { message, select } = choiceParts(choice);

    assert.equal(el.children.length, 1);
    assert.equal(message, 'text:"No memline line, choose a line"');
    assert.equal(select.view, 'select');
    assert.deepEqual(choice.data, [cpuOnly.timeline]);

    // The timeline has a breakdown of the requested kind
    select.onChange(cpuOnly.timeline);

    const [content] = el.children;

    assert.equal(el.children.length, 1);
    assert.equal(content.config, 'text:"content"');
    assert.equal(content.context.scopeLine, cpuOnly.timeline);
    assert.equal(content.context.scopeBreakdown.kind, 'call-stack');
    assert.equal(scope.line, null);
});

test('an element without a request and with a single choice is taken, several choices are offered', async () => {
    const { session, main, worker, first } = await createSessionFixture();
    const fromSession = deriveScope(createRootScope([session], null, 'timeline', null), { session });
    const el = renderView(config, { scope: fromSession });
    const threadChoice = choiceParts(el.children[0]);

    // A process of two threads, the main thread has two profiles
    assert.equal(threadChoice.message, 'text:"Choose a thread"');
    assert.deepEqual(el.children[0].data, [main, worker]);

    threadChoice.select.onChange(main);

    const profileChoice = choiceParts(el.children[0]);

    assert.equal(profileChoice.message, 'text:"Choose a profile"');

    profileChoice.select.onChange(first);

    // The timeline has two breakdowns and no kind is requested
    assert.equal(choiceParts(el.children[0]).message, 'text:"Choose a breakdown"');
    assert.deepEqual(el.children[0].data, first.timeline.breakdowns);
});

test('a missing element without choices is told', async () => {
    const { session, gpu } = await createSessionFixture();
    const empty = createRootScope([session], null, null, null);
    const el = renderView(config, { scope: deriveScope(empty, { process: gpu }) });

    assert.equal(el.children.length, 1);
    assert.equal(el.children[0].config, 'alert-warning:"No thread to show"');
});

test('an element the view requires is checked apart from elements it is independent of', async () => {
    const { session, cpuOnly } = await createSessionFixture();
    const scope = deriveScope(createRootScope([session], cpuOnly, 'memline', null), { scale: 'time' });
    const el = renderView({ requires: 'scale', content: 'text:"content"' }, { scope });
    const [content] = el.children;

    // The profile has no memory line, the time scale doesn't need one
    assert.equal(scope.line, null);
    assert.equal(content.config, 'text:"content"');
    assert.equal(content.context.scope.scale, cpuOnly.timeline);
});
