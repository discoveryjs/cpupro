import type { UniformTraceEvent } from '../formats/types.js';
import type { CpuProCounterEntry, CpuProThread } from '../types.js';
import { namedEvents } from './thread-events.js';

type UpdateCountersData = {
    jsHeapSizeUsed?: number;
    jsHeapSizeTotal?: number;
};
type GcData = {
    usedHeapSizeBefore?: number;
    usedHeapSizeAfter?: number;
    totalHeapSizeBefore?: number;
    totalHeapSizeAfter?: number;
};

// Heap size counters of a thread in the order of its events: the sizes of counter updates, and the sizes before
// a GC event at its start and after it at its end
export function extractThreadCounters(thread: CpuProThread) {
    const usedHeapSizeCounter: CpuProCounterEntry = {
        name: 'used-heap-size',
        thread,
        unit: 'bytes',
        values: []
    };
    const totalHeapSizeCounter: CpuProCounterEntry = {
        name: 'total-heap-size',
        thread,
        unit: 'bytes',
        values: []
    };
    const { events } = thread;
    const indices = namedEvents(events, ['UpdateCounters', 'MinorGC', 'MajorGC']);

    for (let i = 0; i < indices.length; i++) {
        const event = events[indices[i]];

        if (event.name === 'UpdateCounters') {
            const data = event.data as UpdateCountersData;

            addCounter(usedHeapSizeCounter, event.tm, data.jsHeapSizeUsed, event);
            addCounter(totalHeapSizeCounter, event.tm, data.jsHeapSizeTotal, event);
        } else {
            const data = event.data as GcData;
            const end = event.tm + (event.duration ?? 0);

            addCounter(usedHeapSizeCounter, event.tm, data.usedHeapSizeBefore, event);
            addCounter(totalHeapSizeCounter, event.tm, data.totalHeapSizeBefore, event);
            addCounter(usedHeapSizeCounter, end, data.usedHeapSizeAfter, event);
            addCounter(totalHeapSizeCounter, end, data.totalHeapSizeAfter, event);
        }
    }

    if (usedHeapSizeCounter.values.length > 0) {
        thread.counters.push(usedHeapSizeCounter);
    }

    if (totalHeapSizeCounter.values.length > 0) {
        thread.counters.push(totalHeapSizeCounter);
    }
}

function addCounter(
    counter: CpuProCounterEntry,
    tm: number,
    value: number | undefined | null,
    event: UniformTraceEvent
) {
    if (value === null || value === undefined || isNaN(value)) {
        return;
    }

    counter.values.push({ tm, value, event, counter });
}
