/* eslint-env node */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { extractAndValidate } from '../app/prepare/index.js';
import {
    extractFromGeckoProfile,
    isGeckoProfile
} from '../app/prepare/formats/gecko-profile.js';

function fixture(name: string): unknown {
    return JSON.parse(readFileSync(
        resolve(process.cwd(), 'test', 'fixtures', name),
        'utf8'
    ));
}

test('detects processed Gecko profiles without claiming V8 profiles', () => {
    assert.equal(isGeckoProfile(fixture('samply-cynic-v49.json')), true);
    assert.equal(isGeckoProfile(fixture('samply-cynic-v58.json')), true);
    assert.equal(isGeckoProfile(fixture('firefox-processed-v68.json')), true);
    assert.equal(isGeckoProfile({
        nodes: [],
        samples: [],
        timeDeltas: []
    }), false);
});

test('converts hybrid profiles with shared strings and per-thread tables', () => {
    const input = fixture('samply-cynic-v58.json');
    assert.ok(isGeckoProfile(input));
    const profile = extractFromGeckoProfile(input).profiles[0];

    assert.equal(profile._runtime, 'cynic');
    assert.deepEqual(profile.samples, [3, 3]);
    assert.deepEqual(profile.timeDeltas, [500, 1000]);
    assert.equal(
        typeof profile.nodes[2].callFrame === 'number'
            ? null
            : profile.nodes[2].callFrame.functionName,
        'Heap.collect'
    );
});

test('converts Samply 0.13 per-thread tables into a CPU profile', () => {
    const input = fixture('samply-cynic-v49.json');
    assert.ok(isGeckoProfile(input));
    const result = extractFromGeckoProfile(input);

    assert.equal(result.profiles.length, 1);
    const profile = result.profiles[0];

    assert.equal(profile._name, 'cynic-test262');
    assert.equal(profile._runtime, 'cynic');
    assert.equal(profile._samplesInterval, 1000);
    assert.deepEqual(profile.samples, [4, 3, 4]);
    assert.deepEqual(profile.timeDeltas, [500, 1000, 1500]);
    assert.deepEqual(profile.nodes.map(node => ({
        id: node.id,
        name: typeof node.callFrame === 'number' ? node.callFrame : node.callFrame.functionName,
        children: node.children
    })), [
        { id: 1, name: '(root)', children: [2] },
        { id: 2, name: 'main', children: [3] },
        { id: 3, name: 'lantern.runFrames', children: [4] },
        { id: 4, name: 'Heap.collect', children: undefined }
    ]);

    const leaf = profile.nodes[3].callFrame;
    assert.equal(typeof leaf === 'number' ? null : leaf.url, '/opt/cynic/cynic-test262');
});

test('converts current processed Firefox profiles and source locations', () => {
    const input = fixture('firefox-processed-v68.json');
    assert.ok(isGeckoProfile(input));
    const result = extractFromGeckoProfile(input);
    const profile = result.profiles[0];

    assert.equal(profile._name, 'GeckoMain');
    assert.equal(profile._runtime, 'firefox');
    assert.deepEqual(profile.samples, [3, 3]);
    assert.deepEqual(profile.timeDeltas, [250, 1000]);

    const callFrame = profile.nodes[2].callFrame;
    assert.equal(typeof callFrame === 'number' ? null : callFrame.functionName, 'runScript');
    assert.equal(typeof callFrame === 'number' ? null : callFrame.url, 'file:///work/example.js');
    assert.equal(typeof callFrame === 'number' ? null : callFrame.lineNumber, 11);
    assert.equal(typeof callFrame === 'number' ? null : callFrame.columnNumber, 4);
});

test('accepts Gecko profiles through the common format dispatcher', () => {
    const rejected: string[] = [];
    const result = extractAndValidate(
        fixture('samply-cynic-v49.json'),
        reason => rejected.push(reason)
    );

    assert.deepEqual(rejected, []);
    assert.equal(result.profiles[0]._runtime, 'cynic');
});

test('preserves null samples as root samples and keeps the timeline', () => {
    const input = fixture('samply-cynic-v49.json');
    assert.ok(isGeckoProfile(input));
    input.threads[0].samples.stack[1] = null;
    const profile = extractFromGeckoProfile(input).profiles[0];

    assert.deepEqual(profile.samples, [4, 1, 4]);
    assert.equal(profile.samples.length, profile.timeDeltas.length);
    assert.equal(profile.timeDeltas.reduce((sum, delta) => sum + delta, 0), 3000);
});

test('falls back to a sampled thread when the selected thread is empty', () => {
    const input = fixture('samply-cynic-v49.json');
    assert.ok(isGeckoProfile(input));
    const emptyThread = structuredClone(input.threads[0]);

    emptyThread.name = 'EmptyThread';
    emptyThread.samples.stack = [];
    emptyThread.samples.time = [];
    input.threads.push(emptyThread);
    input.meta.initialSelectedThreads = [1];

    assert.equal(extractFromGeckoProfile(input).profiles[0]._name, 'cynic-test262');
});

test('does not infer Cynic from a similarly named process', () => {
    const input = fixture('samply-cynic-v49.json');
    assert.ok(isGeckoProfile(input));

    input.meta.product = 'Samply';
    input.threads[0].processName = 'cynic-helper';
    input.libs = [{ name: 'libcynic-helper.so', path: '/usr/lib/libcynic-helper.so' }];

    assert.equal(extractFromGeckoProfile(input).profiles[0]._runtime, 'unknown');
});

test('detects official Cynic benchmark recordings', () => {
    const input = fixture('samply-cynic-v49.json');
    assert.ok(isGeckoProfile(input));

    input.meta.product = 'cynic-bench';
    input.threads[0].processName = 'cynic-bench';
    input.libs = [{ name: 'cynic-bench', path: '/opt/cynic/cynic-bench' }];

    assert.equal(extractFromGeckoProfile(input).profiles[0]._runtime, 'cynic');
});

test('rejects non-CPU Gecko sample weights', () => {
    const input = fixture('samply-cynic-v49.json');
    assert.ok(isGeckoProfile(input));
    input.threads[0].samples.weightType = 'bytes';

    assert.throws(
        () => extractFromGeckoProfile(input),
        /unsupported sample weight type "bytes"/
    );
});

test('expands positive Gecko sample weights without changing total time', () => {
    const input = fixture('samply-cynic-v49.json');
    assert.ok(isGeckoProfile(input));
    input.threads[0].samples.weight = [1, 2, 1];
    const profile = extractFromGeckoProfile(input).profiles[0];

    assert.deepEqual(profile.samples, [4, 3, 3, 4]);
    assert.deepEqual(profile.timeDeltas, [500, 500, 500, 1500]);
    assert.equal(profile.timeDeltas.reduce((sum, delta) => sum + delta, 0), 3000);
});

test('rejects non-positive Gecko sample weights', () => {
    const input = fixture('samply-cynic-v49.json');
    assert.ok(isGeckoProfile(input));
    input.threads[0].samples.weight = [1, -1, 1];

    assert.throws(
        () => extractFromGeckoProfile(input),
        /unsupported sample weight -1/
    );
});

test('bounds expansion of Gecko sample weights', () => {
    const input = fixture('samply-cynic-v49.json');
    assert.ok(isGeckoProfile(input));
    input.threads[0].samples.weight = [10_000_001, 1, 1];

    assert.throws(
        () => extractFromGeckoProfile(input),
        /expands beyond 10000000 samples/
    );
});

test('accepts existing V8 CPU profiles through the common dispatcher', () => {
    const input = {
        startTime: 0,
        endTime: 1000,
        nodes: [{
            id: 1,
            callFrame: {
                scriptId: '0',
                url: '',
                functionName: '(root)',
                lineNumber: -1,
                columnNumber: -1
            }
        }],
        samples: [1],
        timeDeltas: [1000]
    };
    const rejected: string[] = [];
    const result = extractAndValidate(input, reason => rejected.push(reason));

    assert.deepEqual(rejected, []);
    assert.deepEqual(result.profiles[0].samples, [1]);
});
