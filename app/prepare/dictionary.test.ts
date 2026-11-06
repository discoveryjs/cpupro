import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Dictionary } from './dictionary.js';
import { createScript } from './preprocessing/scripts.js';

test('resolves a script location without a position to the script call frame location', () => {
    const dictionary = new Dictionary();
    const script = createScript(1, 'fixture.js', 'function a() {}\nfunction b() {}\n');

    script.module = dictionary.resolveModule(script);
    dictionary.scripts.push(script);

    // offset locations go first so location and call frame indices diverge
    for (let offset = 3; offset < 6; offset++) {
        dictionary.resolveLocationIndex(null, script, offset);
    }

    const scriptFrame = dictionary.callFrames[dictionary.resolveScriptCallFrameIndex(script)];
    const location = dictionary.locations[dictionary.resolveLocationIndex(null, script)];

    assert.equal(location, dictionary.resolveLocation(scriptFrame));
    assert.equal(location.callFrame, scriptFrame);
    assert.equal(location.scriptOffset, -1);
});
