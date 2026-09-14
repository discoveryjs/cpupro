import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PopulationFilter, SetAttributeFilter } from './population-filter.js';
import { Observer } from './misc.js';
import { Population, PopulationFiltered } from './population.js';

test('registers inactive filters without applying and supports custom attribute implementations', () => {
    class EvenFilter extends Observer {
        key = 'even';
        label = 'Even';
        domain = 'sample' as const;
        size = 3;
        active = false;
        compile() {
            return (index: number) => index % 2 === 0;
        }
        enable() {
            this.active = true; this.notify();
        }
        reset() {
            this.active = false; this.notify();
        }
    }
    const mask = new Uint32Array(3);
    let applications = 0;
    const manager = new PopulationFilter(3, 0, update => {
        update(mask); applications++;
    });
    const custom = new EvenFilter();
    manager.add(custom);
    assert.equal(applications, 0);
    custom.enable();
    assert.deepEqual([...mask], [0, 1, 0]);
    assert.equal(applications, 1);
    manager.reset();
    assert.deepEqual([...mask], [0, 0, 0]);
});

test('uses all 32 bits and reuses a removed bit only after clearing it', () => {
    const mask = new Uint32Array(1);
    const manager = new PopulationFilter(1, 0, update => update(mask));
    const filters = Array.from({ length: 33 }, (_, index) => new SetAttributeFilter(
        String(index), String(index), 'sample', 1, [{ key: 'value', label: 'Value' }], () => 0
    ));
    manager.batch(() => filters.slice(0, 32).forEach(filter => manager.add(filter)));
    assert.throws(() => manager.add(filters[32]), /at most 32/);
    filters[31].setEnabled('value', false);
    assert.equal(mask[0], 0x80000000);
    manager.batch(() => {
        manager.remove('31'); manager.add(filters[32]);
    });
    assert.equal(mask[0], 0);
    filters[32].setEnabled('value', false);
    assert.equal(mask[0], 0x80000000);
    manager.reset();
    assert.equal(mask[0], 0);
});

test('transfers settings by semantic key, independently of option order and missing values', () => {
    const first = new SetAttributeFilter('space', 'Space', 'event', 2,
        [{ key: 'new', label: 'New' }, { key: 'old', label: 'Old' }], index => index);
    const second = new SetAttributeFilter('space', 'Space', 'event', 2,
        [{ key: 'old', label: 'Old' }, { key: 'new', label: 'New' }], index => index);
    first.setEnabled('old', false);
    second.setExcludedKeys(first.excludedKeys);
    assert.deepEqual([0, 1].map(first.compile()), [true, false]);
    assert.deepEqual([0, 1].map(second.compile()), [false, true]);
    second.setExcludedKeys(['old', 'not-present']);
    assert.deepEqual([0, 1].map(second.compile()), [false, true]);
    assert.deepEqual(second.excludedKeys, ['old', 'not-present']);
});

test('population reset and event-filter removal restore compiled samples and keep ranges', () => {
    const population = new PopulationFiltered(new Population(new Uint32Array([0, 0, 0]), new Uint32Array([10, 20, 30])));
    const events = new SetAttributeFilter('events', 'Events', 'event', 3,
        [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }], index => index % 2);
    population.filter.add(events);
    population.setRange(5, 35);
    events.setEnabled('no', false);
    assert.deepEqual([...population.samples], [0, 1, 0]);
    assert.equal(population.sink.total, 20);
    population.resetMask();
    assert.equal(events.active, false);
    assert.equal(population.sink.total, 0);
    assert.equal(population.rangeStart, 5);
    assert.deepEqual([...population.samplesTotal], [30]);
    events.setEnabled('yes', false);
    population.filter.remove('events');
    assert.equal(population.sink.total, 0);
    assert.deepEqual(population.samples, population.population.samples);
});

test('composes extensible filters once per batch and releases their bits on removal', () => {
    const mask = new Uint32Array(3);
    let applications = 0;
    const manager = new PopulationFilter(3, 4, update => {
        applications++;
        update(mask);
    });
    const options = [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }];
    const first = new SetAttributeFilter('custom', 'Custom', 'sample', 3, options, index => index % 2);
    const second = new SetAttributeFilter('other', 'Other', 'sample', 3, options, () => 0);
    manager.batch(() => {
        manager.add(first); manager.add(second);
    });
    applications = 0;
    manager.batch(() => {
        first.setEnabled('yes', false); second.setEnabled('yes', false);
    });
    assert.equal(applications, 1);
    assert.deepEqual([...mask], [3, 2, 3]);
    first.reset();
    assert.deepEqual([...mask], [2, 2, 2]);
    manager.remove('other');
    assert.deepEqual([...mask], [0, 0, 0]);
    const calls = applications;
    second.setEnabled('no', false);
    assert.equal(applications, calls);
    assert.throws(() => manager.add(first), /already registered/);
    assert.throws(() => manager.add(new SetAttributeFilter('bad', 'Bad', 'event', 3, options, () => 0)), /incompatible/);
});

test('compiles only changed filters and supports independent events in the same bucket', () => {
    let acceptsEvent: ((index: number) => boolean) | null = null;
    const manager = new PopulationFilter(1, 3, (update, accepts) => {
        update(new Uint32Array(1)); acceptsEvent = accepts;
    });
    const options = [{ key: 'alive', label: 'Alive' }, { key: 'gced', label: 'GCed' }];
    const filter = new SetAttributeFilter('liveness', 'Liveness', 'event', 3, options, index => index % 2);
    let compiled = 0;
    const compile = filter.compile.bind(filter);
    filter.compile = () => {
        compiled++; return compile();
    };
    manager.add(filter);
    assert.equal(compiled, 0);
    filter.setEnabled('gced', false);
    assert.equal(compiled, 1);
    assert.deepEqual([0, 1, 2].map(index => acceptsEvent!(index)), [true, false, true]);
    manager.add(new SetAttributeFilter('custom', 'Custom', 'sample', 1, [{ key: 'all', label: 'All' }], () => 0));
    assert.equal(compiled, 1);
    manager.reset();
    assert.equal(acceptsEvent, null);
    assert.deepEqual(filter.excludedKeys, []);
});
