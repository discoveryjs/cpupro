import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { SetAttributeFilter } from '../computations/attribute-filter.js';
import { prepareLineRange, applyRangeToPopulation } from './range.js';
import { RangeSelection, RangeView } from '../computations/range.js';
import { CoordinateFrame } from '../computations/coordinates.js';
import { Population, PopulationFiltered } from '../computations/population.js';

test('one line range updates both memline populations once and keeps timeline independent', async () => {
    const { profile } = await createProfileFixture({ allocationGc: [0, 1, 0, 2] });
    const line = profile.memline!;
    const populations = [...new Set(line.breakdowns.map(breakdown => breakdown.populationFiltered))];
    const updates = populations.map(() => 0);
    const prepared = populations.map(population => population.filter.get('category'));
    populations.forEach((population, index) => population.subscribe(() => updates[index]++));
    line.range.setRange(8, 80);
    assert.deepEqual(updates, [1, 1]);
    line.range.setRange(8, 80);
    assert.deepEqual(updates, [1, 1]);
    for (const breakdown of line.breakdowns) {
        assert.equal(breakdown.populationFiltered.rangeStart, 8);
        assert.equal(breakdown.populationFiltered.rangeEnd, 80);
        const metrics = breakdown.callFrames!.filtered.nodes;
        assert.equal(metrics.selfValues[0] + metrics.nestedValues[0], 72);
    }
    assert.equal(profile.timeline!.range.ranges, null);
    assert.equal(profile.timeline!.breakdowns[0].populationFiltered.rangeStart, null);
    const liveness = line.filters.get('allocationLiveness') as SetAttributeFilter;
    liveness.setSelection('include', ['alive']);
    populations[0].setIndexRange(0, 2);
    populations[0].setValueRange(16, 33);
    line.range.resetRange();
    assert.equal(liveness.mode, 'include');
    assert.equal(populations[0].indexEnd, 2);
    assert.equal(populations[0].valueMax, 33);
    assert.equal(populations[0].samplesTotal.reduce((sum, value) => sum + value, 0), 16);
    assert.equal(populations[1].samplesTotal.reduce((sum, value) => sum + value, 0), 64);
    populations.forEach((population, index) => assert.equal(population.filter.get('category'), prepared[index]));
});

test('retains global selection while populations move into, across and out of it', async () => {
    const { profile } = await createProfileFixture();
    const line = profile.memline!;
    const populations = [...new Set(line.breakdowns.map(breakdown => breakdown.populationFiltered))];
    const [first, second] = populations;
    const selection = new RangeSelection(line.range.selection.space);
    const firstFrame = new CoordinateFrame(selection.space, 100);
    const secondFrame = new CoordinateFrame(selection.space, 120);
    const firstView = new RangeView(selection, firstFrame, { start: 0, end: 160 });
    const secondView = new RangeView(selection, secondFrame, { start: 0, end: 160 });
    const stopFirst = applyRangeToPopulation(firstView, first);
    const stopSecond = applyRangeToPopulation(secondView, second);
    selection.setRange(108, 180);
    assert.equal(first.rangeStart, 8);
    assert.equal(first.rangeEnd, 80);
    assert.equal(second.rangeStart, 0);
    assert.equal(second.rangeEnd, 60);
    const values = first.values;
    const cumulative = first.cumulative;
    firstFrame.setOrigin(200);
    assert.equal(first.rangeStart, 0);
    assert.equal(first.rangeEnd, 0);
    assert.equal(first.rangeSamples, 0);
    assert.ok(first.values.every(value => value === 0));
    firstFrame.setOrigin(-100);
    assert.deepEqual(firstView.coverage, []);
    assert.deepEqual(first.ranges, []);
    firstFrame.setOrigin(100);
    assert.equal(first.rangeStart, 8);
    assert.equal(first.rangeEnd, 80);
    assert.deepEqual(selection.ranges, [{ start: 108, end: 180 }]);
    assert.equal(first.values, values);
    assert.equal(first.cumulative, cumulative);
    selection.setRange(110.5, 110.75);
    assert.equal(first.rangeSamples, 1);
    assert.equal(first.values.filter(value => value > 0).length, 1);
    assert.ok(first.samplesTotal.every(value => value === 0));
    assert.ok(first.samplesCount.every(value => value === 0));
    assert.deepEqual(first.sink, { total: 0, count: 0 });
    selection.resetRange();
    firstFrame.setOrigin(1000);
    assert.equal(first.rangeStart, null);
    assert.deepEqual(first.values, first.population.values);
    stopFirst();
    stopSecond();
});

test('integration applies existing selection, detaches both subscriptions and honors timeline origin', async () => {
    const { profile } = await createProfileFixture({ cpuOnly: true });
    const line = profile.timeline!;
    const original = line.breakdowns[0];
    const origin = line.axisStart + line.axisStartNoSamples;
    assert.equal(line.range.frame.origin, origin);
    const population = new Population(original.population.samples, original.population.values);
    const populationViewport = new PopulationFiltered(population);
    const filtered = new PopulationFiltered(populationViewport);
    const selection = new RangeSelection(line.range.selection.space);
    const frame = new CoordinateFrame(selection.space, origin);
    const range = new RangeView(selection, frame, { start: 0, end: 30 });
    selection.setRange(origin + 5, origin + 25);
    const testLine = { ...line, range, breakdowns: [{ ...original, population, populationViewport, populationFiltered: filtered }] };
    const stop = prepareLineRange(testLine);
    assert.equal(filtered.rangeStart, 5);
    assert.equal(filtered.rangeEnd, 25);
    stop();
    stop();
    selection.setRange(origin + 8, origin + 15);
    assert.equal(filtered.rangeStart, 5);
    frame.setOrigin(origin + 10);
    assert.equal(filtered.rangeStart, 5);
    const stopUpdated = prepareLineRange(testLine);
    assert.equal(filtered.rangeStart, 0);
    assert.equal(filtered.rangeEnd, 5);
    range.resetRange();
    assert.equal(filtered.rangeStart, null);
    stopUpdated();
});

test('viewport limits selection without changing its request, baseline or topology', async () => {
    const { profile } = await createProfileFixture();
    for (const line of profile.lines) {
        const total = line.axisTotal;
        const origin = line.range.frame.origin;
        const selections = new Set(line.breakdowns.map(breakdown => breakdown.populationFiltered));
        const viewports = new Set(line.breakdowns.map(breakdown => breakdown.populationViewport));
        const baselines = line.breakdowns.map(breakdown => breakdown.callFrames!.all.nodes.selfValues.slice());
        const trees = line.breakdowns.map(breakdown => breakdown.callFrames!.tree);
        line.range.selection.setRange(origin + total * 0.5, origin + total * 0.9);
        const request = line.range.selection.ranges;
        line.viewport.selection.setRange(origin + total * 0.2, origin + total * 0.6);
        for (const viewport of viewports) {
            assert.ok(Math.abs(viewport.samplesTotal.reduce((sum, value) => sum + value, 0) - total * 0.4) < 1);
        }
        for (const selection of selections) {
            assert.ok(Math.abs(selection.samplesTotal.reduce((sum, value) => sum + value, 0) - total * 0.1) < 1);
            assert.deepEqual(selection.ranges, [{ start: total * 0.5, end: total * 0.6 }]);
        }
        assert.equal(line.range.selection.ranges, request);
        line.viewport.setRange(0, total * 0.4);
        for (const selection of selections) {
            assert.deepEqual(selection.ranges, []);
        }
        line.range.resetRange();
        for (const selection of selections) {
            assert.deepEqual(selection.samplesTotal, selection.source.samplesTotal);
            selection.filter.set({ key: 'selection-only', domain: 'sample', size: selection.samplesCount.length, accepts: () => false });
            assert.ok(selection.samplesTotal.every(value => value === 0));
            assert.ok(selection.source.samplesTotal.some(value => value > 0));
            selection.filter.remove('selection-only');
        }
        line.viewport.resetRange();
        for (const [index, breakdown] of line.breakdowns.entries()) {
            assert.deepEqual(breakdown.populationFiltered.samplesTotal, breakdown.population.samplesTotal);
            assert.deepEqual(breakdown.callFrames!.all.nodes.selfValues, baselines[index]);
            assert.equal(breakdown.callFrames!.tree, trees[index]);
        }
    }
});
