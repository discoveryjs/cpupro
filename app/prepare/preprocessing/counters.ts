import { UniformTraceEvent } from '../formats/types';
import { CpuProCounterEntry, CpuProThread } from '../types';

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
    // const totalHeapSizeCounter: CpuProCounterEntry['values'] = [];

    for (const event of thread.events) {
        if (event.name === 'UpdateCounters') {
            addCounter(usedHeapSizeCounter, event.tm, (event.data as UpdateCountersData).jsHeapSizeUsed, event);
            addCounter(totalHeapSizeCounter, event.tm, (event.data as UpdateCountersData).jsHeapSizeTotal, event);
        } else if (event.name === 'MinorGC' || event.name === 'MajorGC') {
            addCounter(usedHeapSizeCounter, event.tm, (event.data as GcData).usedHeapSizeBefore, event);
            addCounter(totalHeapSizeCounter, event.tm, (event.data as GcData).totalHeapSizeBefore, event);
            addCounter(usedHeapSizeCounter, event.tm + (event.duration ?? 0), (event.data as GcData).usedHeapSizeAfter, event);
            addCounter(totalHeapSizeCounter, event.tm + (event.duration ?? 0), (event.data as GcData).totalHeapSizeAfter, event);
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
    event: UniformTraceEvent | null
) {
    if (value === null || value === undefined || isNaN(value)) {
        return;
    }

    counter.values.push({ tm, value, event, counter });
}
