import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Dictionary } from './dictionary.js';
import { createScript } from './preprocessing/scripts.js';
import type { CpuProLocation } from './types.js';
import { createScriptFixture } from '../../test/fixtures/scripts.js';

test('resolves a script location without a position to the script call frame location', () => {
    const dictionary = new Dictionary();
    const script = createScript(1, 'fixture.js', 'function a() {}\nfunction b() {}\n');

    script.module = dictionary.resolveModule(script);
    dictionary.scripts.push(script);

    // offset locations go first so location and call frame indices diverge
    for (let i = 3; i < 6; i++) {
        dictionary.resolveLocationIndex(null, script, i);
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
    const indices = Object.values(dictionary.callFrames.wellKnownIndex);

    for (let i = 0; i < indices.length; i++) {
        assert.equal(dictionary.locations[indices[i]], dictionary.callFrames[indices[i]].location);
    }
});

test('resolves locations of a script at ascending offsets as it resolves them one by one', () => {
    const source = 'function outer() {\n  const inner = () => [1];\n  return inner() + 1;\n}\nouter();\n';
    // offsets from before the script's start to after its end, inside nested functions, at their bounds and between
    const scriptOffsets = Array.from({ length: source.length + 3 }, (_, offset) => offset - 1);
    const describeLocation = (location: CpuProLocation) => [
        location.scriptOffset,
        location.line,
        location.column,
        location.callFrame.name,
        location.callFrame.start,
        location.callFrame.end
    ].join(' ');
    const batch = createScriptFixture(source);
    const single = createScriptFixture(source);
    const resolveOneByOne = (offset: number) => single.dictionary.resolveLocation(null, single.script, offset);
    const batchLocation = (index: number) => batch.dictionary.locations[index];
    const locationIndices = batch.dictionary.resolveScriptOffsetLocationIndices(batch.script, scriptOffsets);

    assert.deepEqual(
        [...locationIndices].map(batchLocation).map(describeLocation),
        scriptOffsets.map(resolveOneByOne).map(describeLocation)
    );
    // the same locations are added, in another order
    assert.deepEqual(
        batch.dictionary.locations.map(describeLocation).sort(),
        single.dictionary.locations.map(describeLocation).sort()
    );
});
