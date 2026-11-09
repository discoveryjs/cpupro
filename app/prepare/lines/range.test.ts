import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProfileFixture } from '../../../test/fixtures/profile.js';
import { RangeSelection, RangeView } from '../computations/range.js';
import { CoordinateFrame } from '../computations/coordinates.js';
import { Population, PopulationFiltered } from '../computations/population.js';
import { prepareLineRange, applyRangeToPopulation, viewportWindow, windowHolds } from './range.js';
import { methods } from '../../jora/bin.js';
import { lineWindow } from '../../jora/viewport.js';

const sum = (values: ArrayLike<number>) => Array.prototype.reduce.call(values, (total: number, value: number) => total + value, 0) as number;
import type { SetAttributeFilter } from '../computations/attribute-filter.js';

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

test('a viewport window is the aligned cells of the level within twice the viewport', () => {
    const extent = { start: 100, end: 1100 };
    const windowOf = (start: number, end: number) => viewportWindow([{ start, end }], extent);

    assert.equal(viewportWindow(null, extent), null);
    assert.deepEqual(viewportWindow([], extent), []);
    assert.equal(windowOf(100, 1100), null);
    assert.equal(windowOf(200, 700), null);
    // A cell of exactly twice the viewport size is kept
    assert.equal(windowOf(100, 600), null);
    assert.deepEqual(windowOf(500, 700), [{ start: 350, end: 850 }]);
    // Moving or zooming inside the window keeps it
    assert.deepEqual(windowOf(520, 680), [{ start: 350, end: 850 }]);
    assert.deepEqual(windowOf(360, 500), [{ start: 350, end: 600 }]);
    assert.deepEqual(windowOf(0, 150), [{ start: -150, end: 350 }]);
    assert.deepEqual(windowOf(1080, 1100), [{ start: 1068.75, end: 1100 }]);
    // A viewport beyond the extent stays inside its window
    assert.deepEqual(windowOf(0, 1200), [{ start: -900, end: 2100 }]);

    for (let start = 100; start < 1100; start += 37.3) {
        for (let size = 0.01; start + size <= 1100; size *= 1.7) {
            const [window] = windowOf(start, start + size) ?? [extent];
            const length = window.end - window.start;

            assert.ok(window.start <= start && window.end >= start + size);
            assert.ok(length <= 4 * size || length === 1000, `${start} ${size}`);
        }
    }
});

test('a window is kept while it contains the zoom within 4 zoom sizes', async () => {
    const extent = { start: 0, end: 1 };
    const { profile } = await createProfileFixture();
    const line = profile.memline!;
    const total = line.axisTotal;
    const window = () => line.window.selection.ranges?.map(({ start, end }) => [start / total, end / total]) ?? null;
    let windowChanges = 0;

    assert.equal(windowHolds(null, null, extent), true);
    assert.equal(windowHolds(null, [], extent), false);
    assert.equal(windowHolds([], [], extent), true);
    assert.equal(windowHolds([], [{ start: 0.1, end: 0.2 }], extent), false);
    assert.equal(windowHolds(null, [{ start: 0.125, end: 0.375 }], extent), true);
    assert.equal(windowHolds(null, [{ start: 0.125, end: 0.37 }], extent), false);
    assert.equal(windowHolds(null, [{ start: -0.1, end: 0.5 }], extent), false);
    assert.equal(windowHolds([{ start: 0.25, end: 0.5 }], [{ start: 0.25, end: 0.5 }], extent), true);

    line.window.selection.subscribe(() => windowChanges++);
    line.zoom.setRange(total * 0.4, total * 0.45);
    assert.deepEqual(window(), [[0.375, 0.5]]);
    // Zooming in within a quarter of the window and panning inside it keep the window
    line.zoom.setRange(total * 0.41, total * 0.445);
    line.zoom.setRange(total * 0.45, total * 0.4813);
    assert.deepEqual(window(), [[0.375, 0.5]]);
    assert.equal(windowChanges, 1);
    // Leaving the window or zooming in deeper move it to the window of the zoom
    line.zoom.setRange(total * 0.48, total * 0.51);
    assert.deepEqual(window(), [[0.46875, 0.53125]]);
    line.zoom.setRange(total * 0.5, total * 0.51);
    assert.deepEqual(window(), [[0.5, 0.515625]]);
    // Zooming out keeps the whole extent until the zoom is under a quarter of it
    line.zoom.setRange(total * 0.2, total * 0.6);
    assert.equal(window(), null);
    line.zoom.setRange(total * 0.3, total * 0.56);
    assert.equal(window(), null);
    assert.equal(windowChanges, 4);
    line.zoom.resetRange();
});

test('the window of the zoom is within the viewport, a new viewport ends the zoom and is shown whole', async () => {
    const { profile } = await createProfileFixture();
    const line = profile.memline!;
    const total = line.axisTotal;
    const window = () => line.window.selection.ranges?.map(({ start, end }) => [start / total, end / total]) ?? null;
    const viewport = () => line.viewport.selection.ranges?.map(({ start, end }) => [start / total, end / total]) ?? null;
    let windowChanges = 0;

    line.window.selection.subscribe(() => windowChanges++);

    // Without a zoom the window is the viewport, its cells are halvings of the viewport
    line.viewport.setRange(total * 0.2, total * 0.6);
    assert.deepEqual(window(), viewport());
    line.zoom.setRange(total * 0.25, total * 0.3);
    assert.deepEqual(window(), [[0.2, 0.3]]);
    line.zoom.setRange(total * 0.45, total * 0.6);
    assert.deepEqual(window(), [[0.4, 0.6]]);
    assert.equal(windowChanges, 3);

    // A new viewport ends the zoom, though the previous window would hold it
    line.viewport.setRange(total * 0.4, total * 0.6);
    assert.equal(line.zoom.selection.ranges, null);
    assert.deepEqual(window(), viewport());
    assert.equal(windowChanges, 3);
    line.viewport.setRange(total * 0.42, total * 0.6);
    assert.deepEqual(window(), viewport());
    assert.equal(windowChanges, 4);

    line.viewport.resetRange();
    assert.equal(window(), null);
    assert.equal(line.zoom.selection.ranges, null);
});

test('histograms follow the window of the zoom with the viewport filters', async () => {
    const { profile } = await createProfileFixture({ allocationGc: [0, 1, 0, 1] });
    const line = profile.memline!;
    const [{ populationViewport, populationWindow }] = line.breakdowns;
    const context = { scopeProfile: profile, scopeLine: line, scopeBreakdown: line.breakdowns[0] };
    const total = line.axisTotal;
    const windowBins = () => methods.binLineToAxisLine.call({ context: { ...context, scopeViewport: lineWindow(line) } }, line, null, line, 8)[0].bins;
    let windowUpdates = 0;

    populationWindow.subscribe(() => windowUpdates++);
    line.zoom.setRange(total * 0.3, total * 0.45);

    // Zooming doesn't change the viewport population
    assert.equal(populationViewport.ranges, null);
    assert.deepEqual(populationWindow.ranges, [{ start: total * 0.25, end: total * 0.5 }]);
    assert.deepEqual(lineWindow(line), { start: total * 0.25, end: total * 0.5 });
    assert.equal(windowUpdates, 1);
    // Window bins outside the zoom keep their values
    const bins = [...windowBins()];
    assert.equal(bins.reduce((sum, value) => sum + value, 0), total * 0.25);

    line.zoom.setRange(total * 0.26, total * 0.4);
    assert.equal(windowUpdates, 1);
    assert.deepEqual([...windowBins()], bins);

    (line.filters.get('allocationLiveness') as SetAttributeFilter).setEnabled('gced', false);
    assert.ok(populationWindow.sink.total > 0);
    // At the whole extent the window and the viewport are the same filtered population
    line.zoom.resetRange();
    assert.equal(populationWindow.ranges, null);
    assert.deepEqual([...populationWindow.samplesTotal], [...populationViewport.samplesTotal]);
    assert.equal(windowBins().reduce((sum, value) => sum + value, 0), sum(populationWindow.samplesTotal));
});
