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

test('inherits sink destinations without reading parent totals or replaying parent predicates', () => {
    const base = new Population(new Uint32Array([0, 0, 1, 2]), new Uint32Array([10, 20, 30, 40]), 2);
    assert.equal(base.sinkId, 2);
    assert.deepEqual(base.sink, { count: 1, total: 40 });
    const viewport = new PopulationFiltered(base);
    let parentEvaluations = 0;
    viewport.filter.set({ key: 'parent', domain: 'event', size: 4, accepts(index) {
        assert.notEqual(index, 3);
        parentEvaluations++;
        return index !== 1;
    } });
    assert.equal(parentEvaluations, 3);
    viewport.samplesTotal.fill(1234);
    viewport.samplesCount.fill(4321);
    viewport.buffer.samplesTotal[viewport.sinkId] = 9876;
    const selection = new PopulationFiltered(viewport);
    assert.deepEqual([...selection.samples], [0, 2, 1, 2]);
    assert.deepEqual([...selection.samplesTotal], [10, 30]);
    assert.deepEqual(selection.sink, { count: 2, total: 60 });
    const inputVisits: number[] = [];
    selection.filter.set({ key: 'own', domain: 'sample', size: 2, accepts(sampleId) {
        assert.ok(sampleId < selection.samplesCount.length);
        return true;
    } });
    selection.filter.set({ key: 'own-event', domain: 'event', size: 4, accepts(index) {
        inputVisits.push(index);
        return true;
    } });
    assert.deepEqual(inputVisits, [0, 2]);
    viewport.setRange(5, 85);
    selection.setRange(15, 75);
    assert.deepEqual([...selection.values], [0, 20, 30, 40]);
    assert.deepEqual([...selection.samplesTotal], [0, 30]);
    assert.deepEqual(selection.sink, { count: 2, total: 30 });
    assert.equal(parentEvaluations, 3);
    assert.deepEqual(inputVisits, [0, 2]);
    selection.resetRange();
    selection.updateMask(mask => mask.fill(1));
    selection.resetMask();
    selection.filter.remove('own-event');
    selection.filter.remove('own');
    assert.deepEqual([...selection.samples], [0, 2, 1, 2]);
    viewport.filter.remove('parent');
    assert.deepEqual([...selection.samples], [0, 0, 1, 2]);
    assert.deepEqual([...selection.samplesTotal], [25, 30]);
    assert.deepEqual(selection.sink, { count: 1, total: 25 });
    assert.equal(parentEvaluations, 3);
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
                viewport.filter.set({ key: 'source', domain: 'event', size: 6, accepts: filtered ? index => index !== 2 : null });
                selection.filter.set({ key: 'selection', domain: 'sample', size: 3, accepts: filtered ? sampleId => sampleId !== 1 : null });
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
                assert.deepEqual(selection.buffer.samplesTotal, totals);
                assert.deepEqual(selection.buffer.samplesCount, counts);
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
    assert.deepEqual([...values], [10, 0, 30]);
    assert.deepEqual([...filtered.samplesTotal], [14, 0]);
    assert.equal(filtered.rangeSamples, 2);
    filtered.setIndexRange(1, 3);
    assert.deepEqual([...values], [0, 0, 30]);
    assert.deepEqual([...filtered.samplesTotal], [10, 0]);
    assert.equal(filtered.rangeSamples, 2);
    filtered.resetIndexRange();
    assert.deepEqual([...values], [10, 0, 30]);
    assert.deepEqual([...filtered.samplesTotal], [14, 0]);
    filtered.setRanges([{ start: 0.1, end: 0.7 }, { start: 1.1, end: 1.7 }]);
    assert.deepEqual([...values], [10, 0, 0]);
    assert.deepEqual([...filtered.samplesTotal], [1, 0]);
    assert.equal(filtered.rangeSamples, 1);
    filtered.setValueRange(20, null);
    assert.deepEqual([...values], [0, 0, 0]);
    assert.equal(filtered.rangeSamples, 1);
    filtered.resetValueRange();
    filtered.setRanges([{ start: -2, end: 5 }, { start: 40, end: 100 }]);
    filtered.updateMask(mask => {
        mask[0] = 1;
    });
    assert.deepEqual([...values], [10, 0, 30]);
    assert.equal(filtered.sink.total, 25);
    filtered.setRanges([]);
    assert.equal(filtered.rangeSamples, 0);
    assert.deepEqual([...values], [0, 0, 0]);
    filtered.resetRange();
    assert.deepEqual(values, base.values);
    assert.equal(filtered.values, values);
    assert.equal(filtered.samples, samples);
    assert.equal(filtered.sink.total, 40);
});

test('matches scalar overlap through multi-range, mask, index and value transitions', () => {
    const weights = [0, 0, 10, 0, 20, 0, 0, 30, 0, 40, 0];
    const base = new Population(Uint32Array.from(weights, (_, index) => index % 3), Uint32Array.from(weights));
    const filtered = new PopulationFiltered(base);
    const values = filtered.values;
    const destinations = filtered.samples;
    filtered.updateMask(mask => {
        mask[0] = 1;
    });
    let seed = 54321;
    const random = (size: number) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % size;
    };
    const verify = () => {
        let rangeSamples = 0;
        const fullValues = new Uint32Array(weights.length);
        const expected = base.values.map((value, index) => {
            const start = base.cumulative[index];
            const contribution = filtered.ranges === null ? value : filtered.ranges.reduce((sum, range) =>
                sum + Math.max(0, Math.min(start + value, range.end) - Math.max(start, range.start)), 0);
            rangeSamples += contribution > 0 ? 1 : 0;
            const accepted = index >= (filtered.indexStart ?? 0) && index < (filtered.indexEnd ?? weights.length) &&
                value >= (filtered.valueMin ?? -Infinity) && value < (filtered.valueMax ?? Infinity);
            fullValues[index] = accepted && contribution > 0 ? value : 0;
            return accepted ? contribution : 0;
        });
        const counts = new Uint32Array(filtered.samplesCount.length + 1);
        const totals = new Uint32Array(counts.length);
        expected.forEach((value, index) => {
            const sampleId = destinations[index];
            totals[sampleId] += value;
            counts[sampleId] += value > 0 ? 1 : 0;
        });
        assert.deepEqual(values, fullValues);
        assert.equal(filtered.values, values);
        assert.equal(filtered.samples, destinations);
        assert.equal(filtered.rangeSamples, filtered.ranges === null ? null : rangeSamples);
        assert.deepEqual(filtered.samplesCount, counts.subarray(0, filtered.samplesCount.length));
        assert.deepEqual(filtered.samplesTotal, totals.subarray(0, filtered.samplesTotal.length));
        assert.deepEqual(filtered.sink, { count: counts[filtered.sinkId], total: totals[filtered.sinkId] });
    };

    for (let pass = 0; pass < 120; pass++) {
        const ranges = Array.from({ length: 2 + random(10) }, () => {
            const start = random(420) / 4 - 2;
            return { start, end: start + random(40) / 4 };
        });
        filtered.setRanges(ranges);
        verify();
        const first = random(weights.length + 1);
        const last = random(weights.length + 1);
        filtered.setIndexRange(Math.min(first, last), Math.max(first, last));
        filtered.setValueRange(pass % 2 ? null : 20, pass % 3 ? null : 40);
        verify();
        filtered.resetIndexRange();
        filtered.resetValueRange();
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
    assert.ok(reads <= 23);
    assert.equal(filtered.rangeSamples, 20);
    assert.equal(filtered.samplesTotal[0], 200);
    assert.equal(filtered.values[1000], 0);
});
