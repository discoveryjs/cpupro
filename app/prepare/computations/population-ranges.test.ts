import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Population, PopulationFiltered } from './population.js';

test('derives ranges from full source values and updates when only source coverage changes', () => {
    const base = new Population(new Uint32Array([0]), new Uint32Array([100]));
    const viewport = new PopulationFiltered(base);
    viewport.setRange(20, 60);
    assert.deepEqual([...viewport.values], [100]);
    assert.deepEqual([...viewport.samplesTotal], [40]);
    const selection = new PopulationFiltered(viewport);
    assert.deepEqual(selection.ranges, [{ start: 20, end: 60 }]);
    assert.equal(selection.rangeSamples, 1);
    assert.deepEqual(selection.boundaryCuts, [{ index: 0, value: 60 }]);
    assert.deepEqual([...selection.samplesTotal], [40]);
    selection.setRange(50, 80);
    assert.deepEqual([...selection.values], [100]);
    assert.deepEqual([...selection.samplesTotal], [10]);
    assert.equal(selection.cumulative, base.cumulative);
    assert.equal(selection.sinkId, viewport.sinkId);

    viewport.setRange(40, 80);
    assert.deepEqual([...viewport.values], [100]);
    assert.deepEqual([...viewport.samplesTotal], [40]);
    assert.deepEqual([...selection.samplesTotal], [30]);
    selection.resetRange();
    assert.deepEqual(selection.samplesTotal, viewport.samplesTotal);
    viewport.setRanges([]);
    assert.deepEqual([...selection.values], [0]);
    viewport.resetRange();
    assert.deepEqual(selection.samplesTotal, base.samplesTotal);
});

test('keeps source and local requests separate through disjoint fractional ranges and three levels', () => {
    const base = new Population(new Uint32Array([0, 1]), new Uint32Array([100, 100]));
    const viewport = new PopulationFiltered(base);
    viewport.setRanges([{ start: 0.1, end: 0.7 }, { start: 1.1, end: 1.7 }]);
    const selection = new PopulationFiltered(viewport);
    const nested = new PopulationFiltered(selection);
    const buffers = [viewport, selection, nested].map(population => population.buffer.memory!.buffer);
    assert.equal(new Set(buffers).size, 3);
    assert.equal(nested.cumulative, base.cumulative);
    assert.deepEqual([...nested.values], [100, 0]);
    assert.deepEqual([...nested.samplesTotal], [1, 0]);
    assert.deepEqual([...nested.samplesCount], [1, 0]);
    selection.setRange(0, 1);
    assert.deepEqual([...nested.samplesTotal], [0, 0]);
    assert.deepEqual([...nested.samplesCount], [0, 0]);
    assert.deepEqual([...nested.values], [100, 0]);
    assert.deepEqual(selection.requestedRanges, [{ start: 0, end: 1 }]);

    viewport.setRange(100, 200);
    assert.deepEqual(selection.ranges, []);
    assert.deepEqual(selection.requestedRanges, [{ start: 0, end: 1 }]);
    viewport.setRange(0, 100);
    assert.deepEqual([...nested.samplesTotal], [1, 0]);
    selection.resetRange();
    viewport.setRanges([{ start: 20, end: 35 }, { start: 45, end: 160 }]);
    nested.setRanges([{ start: 30, end: 50 }, { start: 90, end: 180 }]);
    assert.deepEqual(nested.ranges, [{ start: 30, end: 35 }, { start: 45, end: 50 }, { start: 90, end: 160 }]);
    assert.deepEqual([...nested.values], [100, 100]);
    assert.deepEqual([...nested.samplesTotal], [20, 60]);
    assert.deepEqual([...nested.samplesCount], [1, 1]);

    const finalValues = nested.values.slice();
    const finalTotals = nested.samplesTotal.slice();
    nested.destroy();
    nested.destroy();
    selection.setRanges([]);
    assert.deepEqual(nested.values, finalValues);
    assert.deepEqual(nested.samplesTotal, finalTotals);
    assert.deepEqual([viewport, selection, nested].map(population => population.buffer.memory!.buffer), buffers);
});

test('inherits sink destinations and unconstrained source metrics without replaying parent predicates', () => {
    const base = new Population(new Uint32Array([0, 0, 1, 2]), new Uint32Array([10, 20, 30, 40]), 2);
    assert.equal(base.sinkId, 2);
    assert.deepEqual(base.sink, { count: 1, total: 40 });
    const viewport = new PopulationFiltered(base);
    viewport.filter.set({ key: 'parent', domain: 'event', size: 4, accepts: Uint8Array.of(1, 0, 1, 1) });
    const selection = new PopulationFiltered(viewport);
    assert.deepEqual([...selection.samples], [0, 2, 1, 2]);
    assert.deepEqual([...selection.samplesTotal], [10, 30]);
    assert.deepEqual(selection.sink, { count: 2, total: 60 });
    selection.filter.set({ key: 'own', domain: 'sample', size: 2, accepts: Uint8Array.of(1, 1) });
    selection.filter.set({ key: 'own-event', domain: 'event', size: 4, accepts: Uint8Array.of(1, 1, 1, 1) });
    viewport.setRange(5, 85);
    selection.setRange(15, 75);
    assert.deepEqual([...selection.values], [0, 20, 30, 40]);
    assert.deepEqual([...selection.samplesTotal], [0, 30]);
    assert.deepEqual(selection.sink, { count: 2, total: 30 });
    selection.resetRange();
    selection.filter.remove('own-event');
    selection.filter.remove('own');
    assert.deepEqual([...selection.samples], [0, 2, 1, 2]);
    viewport.filter.remove('parent');
    assert.deepEqual([...selection.samples], [0, 0, 1, 2]);
    assert.deepEqual([...selection.samplesTotal], [25, 30]);
    assert.deepEqual(selection.sink, { count: 1, total: 25 });
});

test('matches scalar source and selection intersections through independent filter and range updates', () => {
    const base = new Population(new Uint32Array([0, 1, 0, 1, 2, 0]), new Uint32Array([10, 0, 20, 30, 0, 40]));
    const viewport = new PopulationFiltered(base);
    const selection = new PopulationFiltered(viewport);
    const sibling = new PopulationFiltered(viewport);
    const values = selection.values;
    const samples = selection.samples;
    const ranges = [null, [], [{ start: 3.5, end: 25.75 }], [{ start: 0.1, end: 0.7 }, { start: 1.1, end: 1.7 }],
        [{ start: 5, end: 35 }, { start: 45, end: 85 }], [{ start: 90, end: 100 }]];
    for (const sourceRanges of ranges) {
        viewport.setRanges(sourceRanges);
        for (const ownRanges of ranges) {
            selection.setRanges(ownRanges);
            for (const filtered of [true, false]) {
                viewport.filter.set({ key: 'source', domain: 'event', size: 6, accepts: filtered ? Uint8Array.of(1, 1, 0, 1, 1, 1) : null });
                selection.filter.set({ key: 'selection', domain: 'sample', size: 3, accepts: filtered ? Uint8Array.of(1, 0, 1) : null });
                const totals = new Uint32Array(4);
                const counts = new Uint32Array(4);
                const expectedValues = new Uint32Array(6);
                for (let index = 0; index < base.values.length; index++) {
                    const start = base.cumulative[index];
                    const end = start + base.values[index];
                    let contribution = 0;
                    for (const parent of sourceRanges ?? [{ start: 0, end: 100 }]) {
                        for (const own of ownRanges ?? [{ start: 0, end: 100 }]) {
                            contribution += Math.max(0, Math.min(end, parent.end, own.end) - Math.max(start, parent.start, own.start));
                        }
                    }
                    expectedValues[index] = contribution > 0 ? base.values[index] : 0;
                    const sampleId = filtered && (index === 2 || base.samples[index] === 1) ? selection.sinkId : base.samples[index];
                    assert.equal(selection.samples[index], sampleId);
                    const effectiveValue = Math.trunc(contribution);
                    totals[sampleId] += effectiveValue;
                    counts[sampleId] += effectiveValue > 0 ? 1 : 0;
                }
                assert.deepEqual(selection.values, expectedValues);
                assert.deepEqual([...selection.samplesTotal, selection.sink.total], [...totals]);
                assert.deepEqual([...selection.samplesCount, selection.sink.count], [...counts]);
                assert.deepEqual(sibling.values, viewport.values);
                assert.deepEqual(sibling.samplesTotal, viewport.samplesTotal);
                assert.equal(selection.source, viewport);
                assert.equal(selection.population, base);
                assert.equal(selection.values, values);
                assert.equal(selection.samples, samples);
            }
        }
    }
});

test('materializes disjoint intervals without filling gaps or double-counting boundary events', () => {
    const base = new Population(new Uint32Array([0, 1, 0]), new Uint32Array([10, 20, 30]));
    const filtered = new PopulationFiltered(base);
    const values = filtered.values;
    const samples = filtered.samples;
    filtered.setRanges([{ start: 35, end: 45 }, { start: 2, end: 4 }, { start: 6, end: 8 }]);
    assert.deepEqual([...filtered.values], [10, 0, 30]);
    assert.deepEqual([...filtered.samplesTotal], [14, 0]);
    assert.equal(filtered.rangeSamples, 2);
    filtered.setRanges([{ start: 0.1, end: 0.7 }, { start: 1.1, end: 1.7 }]);
    assert.deepEqual([...filtered.values], [10, 0, 0]);
    assert.deepEqual([...filtered.samplesTotal], [1, 0]);
    assert.equal(filtered.rangeSamples, 1);
    filtered.setRanges([{ start: -2, end: 5 }, { start: 40, end: 100 }]);
    filtered.filter.set({
        key: 'samples',
        domain: 'sample',
        size: 2,
        accepts: Uint8Array.of(0, 1)
    });
    assert.deepEqual([...filtered.values], [10, 0, 30]);
    assert.equal(filtered.sink.total, 25);
    filtered.setRanges([]);
    assert.equal(filtered.rangeSamples, 0);
    assert.deepEqual([...filtered.values], [0, 0, 0]);
    filtered.resetRange();
    assert.deepEqual(filtered.values, base.values);
    assert.equal(filtered.values, values);
    assert.equal(filtered.samples, samples);
    assert.equal(filtered.sink.total, 40);
});

test.each([
    { name: 'empty', weights: [] },
    { name: 'zero weights', weights: [0, 0, 0] },
    { name: 'single event', weights: [10] },
    { name: 'repeated coordinates', weights: [0, 0, 10, 0, 20, 0, 0, 30, 0, 40, 0] },
    { name: 'uint32 boundary', weights: [0xfffffffe, 1, 0] },
    { name: 'beyond uint32', weights: [0xffffffff, 0xffffffff, 3, 0, 0xffffffff, 7] }
])('matches per-event overlap through range and mask transitions: $name', ({ weights }) => {
    const base = new Population(Uint32Array.from(weights, (_, index) => index % 3), Uint32Array.from(weights));
    const filtered = new PopulationFiltered(base);
    const sampleCount = filtered.samplesMask.length;
    const total = base.cumulativeEnd;
    // Event boundaries, points next to them and inside events, and points outside the population
    const coordinates = [-1, total - 0.25, total, total + 1];
    let seed = 54321;
    const random = (size: number) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % size;
    };
    const verify = () => {
        let rangeSamples = 0;
        const fullValues = new Uint32Array(weights.length);
        const counts = new Uint32Array(filtered.samplesCount.length + 1);
        const totals = new Float64Array(counts.length);
        const destinations = filtered.samples;

        for (let index = 0; index < weights.length; index++) {
            const value = base.values[index];
            const start = base.cumulative[index];
            let contribution = value;

            if (filtered.ranges !== null) {
                contribution = 0;
                for (const range of filtered.ranges) {
                    contribution += Math.max(0, Math.min(start + value, range.end) - Math.max(start, range.start));
                }
                rangeSamples += contribution > 0 ? 1 : 0;
            }

            if (contribution > 0) {
                // Totals are integral, an event is counted when its truncated contribution remains
                const effectiveValue = Math.trunc(contribution);

                fullValues[index] = value;
                totals[destinations[index]] += effectiveValue;
                counts[destinations[index]] += effectiveValue > 0 ? 1 : 0;
            }
        }

        assert.deepEqual(filtered.values, fullValues);
        assert.equal(filtered.rangeSamples, filtered.ranges === null ? null : rangeSamples);
        assert.deepEqual(filtered.samplesCount, counts.subarray(0, filtered.samplesCount.length));
        assert.deepEqual(filtered.samplesTotal, totals.subarray(0, filtered.samplesTotal.length));
        assert.deepEqual(filtered.sink, { count: counts[filtered.sinkId], total: totals[filtered.sinkId] });
    };

    for (let index = 0; index < weights.length; index++) {
        const start = base.cumulative[index];

        coordinates.push(start - 0.25, start, start + 0.25, start + weights[index] / 2);
    }

    const accepts = new Uint8Array(sampleCount).fill(1);

    accepts[0] = 0;
    filtered.filter.set({
        key: 'samples',
        domain: 'sample',
        size: sampleCount,
        accepts
    });

    for (let pass = 0; pass < 120; pass++) {
        const ranges = Array.from({ length: 1 + random(4) }, () => {
            const start = coordinates[random(coordinates.length)];
            const end = coordinates[random(coordinates.length)];

            return { start: Math.min(start, end), end: Math.max(start, end) };
        });

        filtered.setRanges(ranges);
        verify();
        filtered.resetRange();
        verify();
    }
});

test('does not read original event weights in the gaps between selected intervals', () => {
    const length = 100_000;
    const base = new Population(new Uint32Array(length), new Uint32Array(length).fill(10));
    const filtered = new PopulationFiltered(base);
    let reads = 0;
    base.values = new Proxy(base.values, {
        get(target, property) {
            if (typeof property === 'string' && /^\d+$/.test(property)) {
                reads++;
                const index = Number(property);
                assert.ok((index >= 10 && index < 20) || (index >= 90_000 && index < 90_010) || index === length - 1);
            }
            return Reflect.get(target, property, target);
        }
    });
    filtered.setRanges([{ start: 100, end: 200 }, { start: 900_000, end: 900_100 }]);
    // Covered events once, and edge events of each interval again for their cuts
    assert.ok(reads <= 20 + 2 * 3);
    assert.equal(filtered.rangeSamples, 20);
    assert.equal(filtered.samplesTotal[0], 200);
    assert.equal(filtered.values[1000], 0);
});
