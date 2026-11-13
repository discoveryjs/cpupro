import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { CpuProThread } from '../types.js';
import type { UniformTraceEvent } from '../formats/types.js';
import { namedEvents } from './thread-events.js';
import { extractThreadCounters } from './counters.js';

function createThread(events: UniformTraceEvent[]) {
    return {
        events,
        counters: []
    } as unknown as CpuProThread;
}

test('events of names are taken in the order of the events', () => {
    const events = [
        { name: 'MajorGC', tm: 1 },
        { name: 'Paint', tm: 2 },
        { name: 'MinorGC', tm: 3 },
        { name: 'MajorGC', tm: 4 }
    ];

    assert.deepEqual(namedEvents(events, ['MinorGC', 'MajorGC']), Uint32Array.of(0, 2, 3));
    assert.deepEqual(namedEvents(events, ['Paint', 'Layout']), Uint32Array.of(1));
});

test('heap counters take the counter updates and the heap sizes around GC events in their order', () => {
    const thread = createThread([
        { name: 'UpdateCounters', tm: 1, data: { jsHeapSizeUsed: 10, jsHeapSizeTotal: 20 } },
        { name: 'MinorGC', tm: 2, duration: 1, data: { usedHeapSizeBefore: 11, usedHeapSizeAfter: 5 } },
        { name: 'Paint', tm: 4 },
        { name: 'UpdateCounters', tm: 5, data: { jsHeapSizeUsed: 7, jsHeapSizeTotal: 20 } }
    ]);

    extractThreadCounters(thread);

    assert.deepEqual(thread.counters[0].values.map(value => [value.tm, value.value]), [[1, 10], [2, 11], [3, 5], [5, 7]]);
});
