import assert from 'node:assert/strict';
import { test } from 'vitest';
import { allocationAttributes, findBreakdown, scopeContext } from './lines.js';
import { createLineFixture, createProfileFixture } from './profile.js';

type LifespanAttribute = {
    values: ArrayLike<number>;
    dict: string[];
};
type SpaceAttribute = {
    values: ArrayLike<number>;
    dict: { code: string }[];
};

test('allocation attributes give the lifespans and spaces of the fixture allocation events', async () => {
    const { profile } = await createProfileFixture(allocationAttributes);
    const line = profile.memline!;
    const lifespan = line.attributes.find(entry => entry.name === 'allocationLifespan')! as LifespanAttribute;
    const space = line.attributes.find(entry => entry.name === 'allocationSpace')! as SpaceAttribute;
    const lifespanName = (value: number) => lifespan.dict[value];
    const spaceCode = (value: number) => space.dict[value].code;

    assert.deepEqual([...line.values], [16, 32, 48, 64]);
    assert.deepEqual(Array.from(lifespan.values, lifespanName), ['alive', 'short-lived', 'alive', 'long-lived']);
    assert.deepEqual(Array.from(space.values, spaceCode), ['new_space', 'new_space', 'old_space', 'old_space']);
});

test('a breakdown is found by its kind, a missing kind throws', async () => {
    const { profile } = await createProfileFixture();
    const line = profile.memline!;

    assert.equal(findBreakdown(line, 'location').kind, 'location');
    assert.throws(() => findBreakdown(line, 'unknown'), /No breakdown unknown/);
});

test('the scope context of a breakdown is of its line and profile', async () => {
    const { profile, line, breakdown } = await createLineFixture();
    const viewport = { start: 5, end: 15 };

    const context = scopeContext(breakdown, viewport);

    assert.equal(context.scopeViewport, viewport);
    assert.equal(context.scopeLine, line);
    assert.equal(context.scopeProfile, profile);
    assert.equal(context.scopeBreakdown, breakdown);
    assert.equal(scopeContext(breakdown).scopeViewport, null);
});
