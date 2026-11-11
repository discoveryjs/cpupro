import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLineFixture } from './profile.js';

test.each(['timeline', 'memline'] as const)(
    'a line fixture of a %s is a prepared profile graph independent of other fixtures',
    async type => {
        const first = await createLineFixture({ type, origin: 120 });
        const second = await createLineFixture({ type, origin: 120 });
        const { line, profile, breakdown } = first;

        assert.equal(profile[type], line);
        assert.equal(profile.lines.length, 1);
        assert.equal(profile.lines[0], line);
        assert.equal(line.profile, profile);
        assert.equal(breakdown.line, line);
        assert.equal(line.breakdowns[0], breakdown);
        assert.equal(breakdown.population.values, line.values);
        assert.equal(breakdown.populationViewport.source, breakdown.population);
        assert.equal(breakdown.populationFiltered.source, breakdown.populationViewport);
        assert.equal(line.range.frame, line.viewport.frame);
        assert.equal(line.range.selection.space, line.viewport.selection.space);
        assert.notEqual(line.range.selection, line.viewport.selection);

        line.viewport.setRange(5, 15);
        assert.equal(line.range.selection.ranges, null);
        assert.deepEqual(breakdown.populationFiltered.ranges, [{ start: 5, end: 15 }]);
        assert.equal(second.line.viewport.selection.ranges, null);
        assert.equal(second.breakdown.populationFiltered.ranges, null);
    }
);
