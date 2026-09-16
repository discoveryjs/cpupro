import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';
import { createRulerHarness } from '../../test/helpers/ruler.js';
import { createProfileFixture } from '../../test/fixtures/profile.js';
import { resolveScopeProfileLine } from '../jora/profile.js';
import { formatMicrosecondsTime } from '../prepare/misc/time-utils.js';

let renderLineRuler;
let viewOptions;
runInNewContext(readFileSync(new URL('./line-ruler.js', import.meta.url), 'utf8'), {
    discovery: { view: { define(name, render, options) {
        assert.equal(name, 'line-ruler');
        renderLineRuler = render;
        viewOptions = options;
    } } },
    require: () => ({ resolveScopeProfileLine, formatMicrosecondsTime })
});

test('forwards resolved props and callbacks without a container or a second selection owner', async () => {
    const { profile } = await createProfileFixture();
    const harness = createRulerHarness();
    const data = { profile };
    const context = { primaryProfile: profile, primaryLineType: 'timeline' };
    assert.equal(viewOptions.tag, false);
    for (const [line, duration, expected] of [
        [undefined, 1_000_000, formatMicrosecondsTime(100_000, 1_000_000)],
        ['memline', 100_000, '10Kb'],
        [profile.memline, 1_000_000, '0.1Mb']
    ]) {
        const element = harness.createElement('ruler');
        const rangeManager = profile.timeline.range;
        let initialized = 0;
        const onInit = () => initialized++;
        const onChange = () => {};
        const details = { view: 'struct' };
        renderLineRuler.call({ render(target, config, input, scope) {
            assert.equal(target, element);
            assert.equal(config.view, 'ruler');
            assert.equal(config.rangeManager, rangeManager);
            assert.equal(config.onInit, onInit);
            assert.equal(config.onChange, onChange);
            assert.equal(config.details, details);
            assert.equal(input, data);
            assert.equal(scope, context);
            harness.render(target, config, input, scope);
        } }, element, { line, duration, rangeManager, onInit, onChange, details }, data, context);
        const marker = element.children.filter(child => child.className === 'interval-marker')[1];
        assert.equal(marker.dataset.title, expected);
        assert.equal(initialized, 1);
        assert.equal(profile.timeline.range.selection.ranges, null);
        element.children.find(child => child.tag === 'destroy-ruler').onDestroy();
    }
});
