import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { RangeSelection, RangeView } from '../computations/range.js';
import { CoordinateFrame } from '../computations/coordinates.js';
import { Population, PopulationFiltered } from '../computations/population.js';
import { prepareLineRange, applyRangeToPopulation } from './range.js';

test('a population follows the selection through its view and its frame', async () => {
    const { profile } = await createProfileFixture();
    const population = profile.memline!.breakdowns[0].populationFiltered;
    const selection = new RangeSelection(profile.memline!.range.selection.space);
    const frame = new CoordinateFrame(selection.space, 100);
    const view = new RangeView(selection, frame, { start: 0, end: population.population.cumulativeEnd });
    const stop = applyRangeToPopulation(view, population);
    const { values, cumulative } = population;

    selection.setRange(108, 180);
    assert.deepEqual(population.ranges, [{ start: 8, end: 80 }]);

    for (const origin of [200, -100]) {
        frame.setOrigin(origin);
        assert.deepEqual(population.ranges, []);
        assert.equal(population.rangeSamples, 0);
    }

    frame.setOrigin(100);
    assert.deepEqual(population.ranges, [{ start: 8, end: 80 }]);
    assert.deepEqual(selection.ranges, [{ start: 108, end: 180 }]);
    // Moving through the selection reuses the population buffers
    assert.equal(population.values, values);
    assert.equal(population.cumulative, cumulative);

    selection.resetRange();
    assert.equal(population.ranges, null);
    assert.deepEqual(population.values, population.population.values);

    stop();
    selection.setRange(108, 180);
    assert.equal(population.ranges, null);
});

test('a line range updates each distinct population once and leaves other lines intact', async () => {
    const { profile } = await createProfileFixture();
    const line = profile.memline!;
    const populations = [...new Set(line.breakdowns.map(breakdown => breakdown.populationFiltered))];
    const updates = populations.map(() => 0);

    for (const [index, population] of populations.entries()) {
        population.subscribe(() => updates[index]++);
    }

    line.range.setRange(8, 80);
    line.range.setRange(8, 80);

    assert.deepEqual(updates, [1, 1]);
    for (const { populationFiltered, callFrames } of line.breakdowns) {
        const { selfValues, nestedValues } = callFrames!.filtered.nodes;

        assert.deepEqual(populationFiltered.ranges, [{ start: 8, end: 80 }]);
        assert.equal(selfValues[0] + nestedValues[0], 80 - 8);
    }
    assert.equal(profile.timeline!.breakdowns[0].populationFiltered.ranges, null);
});

test('the selection is limited to the viewport without changing the selection request', async () => {
    const { profile } = await createProfileFixture();

    for (const line of profile.lines) {
        const total = line.axisTotal;
        const origin = line.range.frame.origin;

        line.range.selection.setRange(origin + total * 0.5, origin + total * 0.9);
        const request = line.range.selection.ranges;
        line.viewport.selection.setRange(origin + total * 0.2, origin + total * 0.6);

        for (const { populationViewport, populationFiltered } of line.breakdowns) {
            assert.deepEqual(populationViewport.ranges, [{ start: total * 0.2, end: total * 0.6 }]);
            assert.deepEqual(populationFiltered.ranges, [{ start: total * 0.5, end: total * 0.6 }]);
        }
        assert.equal(line.range.selection.ranges, request);

        line.viewport.setRange(0, total * 0.4);

        for (const { populationFiltered } of line.breakdowns) {
            assert.deepEqual(populationFiltered.ranges, []);
        }
    }
});

test('preparing a line range applies the current selection until it is stopped', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const line = profile.timeline!;
    const original = line.breakdowns[0];
    const population = new Population(original.population.samples, original.population.values);
    const populationViewport = new PopulationFiltered(population);
    const populationFiltered = new PopulationFiltered(populationViewport);
    const selection = new RangeSelection(line.range.selection.space);
    const frame = new CoordinateFrame(selection.space, 1000);
    const range = new RangeView(selection, frame, { start: 0, end: population.cumulativeEnd });
    const preparedLine = { ...line, range, breakdowns: [{ ...original, population, populationViewport, populationFiltered }] };

    selection.setRange(1005, 1025);
    const stop = prepareLineRange(preparedLine);
    assert.deepEqual(populationFiltered.ranges, [{ start: 5, end: 25 }]);

    stop();
    stop();
    selection.setRange(1008, 1015);
    frame.setOrigin(1010);
    assert.deepEqual(populationFiltered.ranges, [{ start: 5, end: 25 }]);

    prepareLineRange(preparedLine);
    assert.deepEqual(populationFiltered.ranges, [{ start: 0, end: 5 }]);
});
