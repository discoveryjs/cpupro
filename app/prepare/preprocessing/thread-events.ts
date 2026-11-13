import type { UniformTraceEvent } from '../formats/types.js';

// Events of a thread by their names, as indices of the events in their order: consumers of a few kinds of events
// (GC events, counters) take them by name rather than going over all events of the thread. Events of a thread are
// taken when its profiling session is created, so the index is built on the first lookup and kept with them
const eventsByName = new WeakMap<UniformTraceEvent[], Map<string, number[]>>();

function getEventsByName(events: UniformTraceEvent[]) {
    let index = eventsByName.get(events);

    if (index === undefined) {
        index = new Map();

        for (let i = 0; i < events.length; i++) {
            const name = events[i].name;
            let indices = index.get(name);

            if (indices === undefined) {
                indices = [];
                index.set(name, indices);
            }

            indices.push(i);
        }

        eventsByName.set(events, index);
    }

    return index;
}

// Indices of the events with any of the names, in the order of the events
export function namedEvents(events: UniformTraceEvent[], names: string[]) {
    const index = getEventsByName(events);
    let count = 0;

    for (let i = 0; i < names.length; i++) {
        count += index.get(names[i])?.length ?? 0;
    }

    const indices = new Uint32Array(count);
    let offset = 0;

    for (let i = 0; i < names.length; i++) {
        const nameIndices = index.get(names[i]);

        if (nameIndices !== undefined) {
            indices.set(nameIndices, offset);
            offset += nameIndices.length;
        }
    }

    // Indices of a name are in order, of several names they're merged
    return indices.sort();
}
