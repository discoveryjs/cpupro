import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Population, PopulationFiltered } from './population.js';

test('materializes disjoint intervals without filling gaps or double-counting boundary events', () => {
    const base = new Population(new Uint32Array([0, 1, 0]), new Uint32Array([10, 20, 30]));
    const filtered = new PopulationFiltered(base);
    const values = filtered.values;
    const samples = filtered.samples;
    filtered.setRanges([{ start: 35, end: 45 }, { start: 2, end: 4 }, { start: 6, end: 8 }]);
    assert.deepEqual([...values], [4, 0, 10]);
    assert.equal(filtered.rangeSamples, 2);
    filtered.setIndexRange(1, 3);
    assert.deepEqual([...values], [0, 0, 10]);
    assert.equal(filtered.rangeSamples, 2);
    filtered.resetIndexRange();
    assert.deepEqual([...values], [4, 0, 10]);
    filtered.setRanges([{ start: 0.1, end: 0.7 }, { start: 1.1, end: 1.7 }]);
    assert.deepEqual([...values], [1, 0, 0]);
    assert.equal(filtered.rangeSamples, 1);
    filtered.setValueRange(20, null);
    assert.deepEqual([...values], [0, 0, 0]);
    assert.equal(filtered.rangeSamples, 1);
    filtered.resetValueRange();
    filtered.setRanges([{ start: -2, end: 5 }, { start: 40, end: 100 }]);
    filtered.updateMask(mask => {
        mask[0] = 1;
    });
    assert.deepEqual([...values], [5, 0, 20]);
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
        const expected = base.values.map((value, index) => {
            const start = base.cumulative[index];
            const contribution = filtered.ranges === null ? value : filtered.ranges.reduce((sum, range) =>
                sum + Math.max(0, Math.min(start + value, range.end) - Math.max(start, range.start)), 0);
            rangeSamples += contribution > 0 ? 1 : 0;
            return index >= (filtered.indexStart ?? 0) && index < (filtered.indexEnd ?? weights.length) &&
                value >= (filtered.valueMin ?? -Infinity) && value < (filtered.valueMax ?? Infinity) ? contribution : 0;
        });
        const counts = new Uint32Array(filtered.sinkId + 1);
        const totals = new Uint32Array(counts.length);
        expected.forEach((value, index) => {
            const sampleId = destinations[index];
            totals[sampleId] += value;
            counts[sampleId] += value > 0 ? 1 : 0;
        });
        assert.deepEqual(values, expected);
        assert.equal(filtered.values, values);
        assert.equal(filtered.samples, destinations);
        assert.equal(filtered.rangeSamples, filtered.ranges === null ? null : rangeSamples);
        assert.deepEqual(filtered.samplesCount, counts.subarray(0, filtered.sinkId));
        assert.deepEqual(filtered.samplesTotal, totals.subarray(0, filtered.sinkId));
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
