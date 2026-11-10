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

test.each([
    ['a script with a source at offset 0', 'function a() {}\n', [0]],
    ['a script with a source at line 0, column 0', 'function a() {}\n', [-1, 0, 0]],
    ['a script without a source at offset 0', null, [0]]
] as const)('resolves the start of %s to the location of the script call frame it adds', (_, source, position) => {
    const dictionary = new Dictionary();
    const script = createScript(1, 'fixture.js', source);

    script.module = dictionary.resolveModule(script);
    dictionary.scripts.push(script);

    const locationCount = dictionary.locations.length;
    const location = dictionary.resolveLocation(null, script, ...position);
    const scriptFrame = dictionary.callFrames[dictionary.resolveScriptCallFrameIndex(script)];

    assert.equal(location, scriptFrame.location);
    assert.equal(location, dictionary.resolveLocation(null, script, 0));
    // The script call frame adds locations without a position and of its start only
    assert.equal(dictionary.locations.length, locationCount + 2);
});

test('adds locations of well-known call frames at the indices of the call frames', () => {
    const dictionary = new Dictionary();

    // createVectorLocations() and the unknown location rely on this for "(unknown)" and "(root)"
    for (const index of Object.values(dictionary.callFrames.wellKnownIndex)) {
        assert.equal(dictionary.locations[index], dictionary.callFrames[index].location);
    }
});
