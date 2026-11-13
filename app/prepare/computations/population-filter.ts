import { Observer } from './misc.js';
import type { Acceptance, PreparedAttributeFilter } from './attribute-filter.js';
type FilterEntry = {
    filter: PreparedAttributeFilter;
    bit: number;
    dirty: boolean;
    active: boolean;
};
// One value per event and its acceptance; populations test exactly one table lookup per event
export type EventAcceptance = {
    values: Uint8Array | Uint16Array | Uint32Array;
    accepts: Acceptance;
};
// Classes of events that every filter over the listed value vectors accepts or rejects together: a key per event,
// the class of every key and the first event of every class. Events are keyed by their classes until a line keys
// them by finer keys (signatures), as it keys the values of its attributes; `ids` give the class of every event,
// materialized when read for queries and views over events (see defineEventClassIds)
export type EventClasses = {
    keys: Uint8Array | Uint16Array | Uint32Array;
    keyClasses: Uint8Array | Uint16Array | Uint32Array;
    events: Uint32Array;
    values: Set<Uint8Array | Uint16Array | Uint32Array>;
    readonly ids: Uint16Array | Uint32Array; // per event: its class
};

// Events without filters over their values are of one class
export function singleEventClass(eventCount: number): EventClasses {
    return defineEventClassIds({
        keys: new Uint8Array(eventCount),
        keyClasses: new Uint8Array(1),
        events: eventCount > 0
            ? Uint32Array.of(0)
            : new Uint32Array(0),
        values: new Set()
    });
}

// Classes of events per event, the classes of their keys, for queries and views over events: materialized when read
// and released once no reader holds them; keys a line takes later give them again
export function defineEventClassIds(classes: Omit<EventClasses, 'ids'>) {
    let keys: EventClasses['keys'] | null = null;
    let ids: WeakRef<Uint16Array | Uint32Array> | null = null;

    Object.defineProperty(classes, 'ids', {
        enumerable: true,
        get() {
            let vector = keys === classes.keys
                ? ids?.deref()
                : undefined;

            if (vector === undefined) {
                const { keyClasses } = classes;

                keys = classes.keys;
                vector = classes.events.length <= 0x10000
                    ? new Uint16Array(keys.length)
                    : new Uint32Array(keys.length);

                for (let i = 0; i < keys.length; i++) {
                    vector[i] = keyClasses[keys[i]];
                }

                ids = new WeakRef(vector);
            }

            return vector;
        }
    });

    return classes as EventClasses;
}

type ApplyFilters = (updateMask: (mask: Uint32Array) => void, acceptedEvents: EventAcceptance | null) => void;

const ACCEPTED_FLAG = Uint8Array.of(0, 1);

export class PopulationFilter extends Observer {
    #entries = new Map<string, FilterEntry>();
    #depth = 0;
    #pending = false;
    #removedBits = 0;
    #removedEvent = false;
    #eventClasses: EventClasses | null = null;

    constructor(
        private readonly sampleCount: number,
        private readonly eventCount: number,
        private readonly apply: ApplyFilters
    ) {
        super();
    }

    get filters(): PreparedAttributeFilter[] {
        return [...this.#entries.values()]
            .map(entry => entry.filter);
    }

    get sampleBits() {
        let bits = 0;

        for (const entry of this.#entries.values()) {
            if (entry.filter.domain === 'sample') {
                bits |= entry.bit;
            }
        }

        return bits;
    }

    // Several event filters over values the classes keep together are then intersected per class, not per event
    setEventClasses(classes: EventClasses | null) {
        this.#eventClasses = classes;
    }

    get(key: string) {
        return this.#entries.get(key)?.filter;
    }

    set(filter: PreparedAttributeFilter) {
        const { key } = filter;

        if (filter.size !== (filter.domain === 'sample' ? this.sampleCount : this.eventCount)) {
            throw new Error(`Filter ${key} has an incompatible ${filter.domain} domain`);
        }

        const existing = this.#entries.get(key);

        if (existing) {
            if (existing.filter.domain !== filter.domain) {
                throw new Error(`Filter ${key} cannot change its domain while registered`);
            }

            if (existing.filter === filter) {
                return filter;
            }

            existing.filter = filter;
            existing.dirty = true;
            this.#schedule();

            return filter;
        }

        const occupied = new Set([...this.#entries.values()].map(entry => entry.bit));
        let bit = 0;

        for (let index = 0; index < 32; index++) {
            const candidate = (1 << index) >>> 0;

            if (!occupied.has(candidate)) {
                bit = candidate;
                break;
            }
        }

        if (!bit) {
            throw new Error('A population supports at most 32 registered attribute filters');
        }

        const entry: FilterEntry = {
            filter,
            bit,
            dirty: true,
            active: false
        };

        this.#entries.set(key, entry);
        this.#schedule();

        return filter;
    }

    remove(key: string) {
        const entry = this.#entries.get(key);

        if (!entry) {
            return;
        }

        this.#entries.delete(key);

        if (entry.filter.domain === 'sample') {
            this.#removedBits |= entry.bit;
        } else if (entry.active) {
            this.#removedEvent = true;
        }

        this.#schedule();
    }

    batch(update: () => void) {
        this.#depth++;

        try {
            update();
        } finally {
            this.#depth--;

            if (!this.#depth && this.#pending) {
                this.#flush();
            }
        }
    }

    #schedule() {
        this.#pending = true;

        if (!this.#depth) {
            this.#flush();
        }
    }

    #flush() {
        const dirtySamples: FilterEntry[] = [];
        const eventFilters: EventAcceptance[] = [];
        let eventsChanged = false;

        this.#pending = false;

        for (const entry of this.#entries.values()) {
            const { filter } = entry;

            if (entry.dirty) {
                const wasActive = entry.active;

                entry.active = filter.accepts !== null;
                entry.dirty = false;

                if (filter.domain === 'sample' && (wasActive || entry.active)) {
                    dirtySamples.push(entry);
                } else if (filter.domain === 'event' && (wasActive || entry.active)) {
                    eventsChanged = true;
                }
            }

            if (filter.domain === 'event' && filter.accepts !== null) {
                eventFilters.push(filter.values
                    ? { values: filter.values, accepts: filter.accepts }
                    : { values: filter.accepts, accepts: ACCEPTED_FLAG }
                );
            }
        }

        const removedBits = this.#removedBits;

        this.#removedBits = 0;

        if (dirtySamples.length || eventsChanged || removedBits || this.#removedEvent) {
            this.#removedEvent = false;
            this.apply(mask => {
                for (let sampleId = 0; sampleId < mask.length; sampleId++) {
                    mask[sampleId] &= ~removedBits;
                }

                // PERF: A filter's bit is set over all samples at once, its values and acceptance read once
                for (const { filter, bit } of dirtySamples) {
                    const { values, accepts } = filter;

                    for (let sampleId = 0; sampleId < mask.length; sampleId++) {
                        const value = values ? values[sampleId] : sampleId;

                        mask[sampleId] = accepts !== null && accepts[value] === 0
                            ? mask[sampleId] | bit
                            : mask[sampleId] & ~bit;
                    }
                }
            }, intersectEventAcceptance(eventFilters, this.#eventClasses));
        }

        this.notify();
    }
}

// Several event filters are intersected into one acceptance: per class when the classes keep the values of every
// filter together, otherwise as per-event flags
function intersectEventAcceptance(filters: EventAcceptance[], classes: EventClasses | null): EventAcceptance | null {
    if (filters.length < 2) {
        return filters[0] ?? null;
    }

    if (classes !== null && filters.every(filter => classes.values.has(filter.values))) {
        const { events, keyClasses } = classes;
        const classAccepts = new Uint8Array(events.length).fill(1);
        const accepts = new Uint8Array(keyClasses.length);

        for (const { values, accepts: filterAccepts } of filters) {
            for (let eventClass = 0; eventClass < classAccepts.length; eventClass++) {
                classAccepts[eventClass] &= filterAccepts[values[events[eventClass]]];
            }
        }

        for (let key = 0; key < accepts.length; key++) {
            accepts[key] = classAccepts[keyClasses[key]];
        }

        return { values: classes.keys, accepts };
    }

    const flags = new Uint8Array(filters[0].values.length).fill(1);

    for (const { values, accepts } of filters) {
        for (let index = 0; index < flags.length; index++) {
            flags[index] &= accepts[values[index]];
        }
    }

    return { values: flags, accepts: ACCEPTED_FLAG };
}
