import { Observer } from './misc.js';
import type { Acceptance, PreparedAttributeFilter } from './attribute-filter.js';
type FilterEntry = {
    filter: PreparedAttributeFilter;
    bit: number;
    dirty: boolean;
    accepts: Acceptance | null;
};
type ApplyFilters = (updateMask: (mask: Uint32Array) => void, acceptsEvent: Acceptance | null) => void;

export class PopulationFilter extends Observer {
    #entries = new Map<string, FilterEntry>();
    #depth = 0;
    #pending = false;
    #removedBits = 0;
    #removedEvent = false;

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
            accepts: null
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
        } else if (entry.accepts) {
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
        const eventFilters: Acceptance[] = [];
        let eventsChanged = false;

        this.#pending = false;

        for (const entry of this.#entries.values()) {
            if (entry.dirty) {
                const wasActive = entry.accepts !== null;

                entry.accepts = entry.filter.accepts;
                entry.dirty = false;

                if (entry.filter.domain === 'sample' && (wasActive || entry.accepts)) {
                    dirtySamples.push(entry);
                } else if (entry.filter.domain === 'event' && (wasActive || entry.accepts)) {
                    eventsChanged = true;
                }
            }

            if (entry.filter.domain === 'event' && entry.accepts) {
                eventFilters.push(entry.accepts);
            }
        }

        const removedBits = this.#removedBits;

        this.#removedBits = 0;

        if (dirtySamples.length || eventsChanged || removedBits || this.#removedEvent) {
            this.#removedEvent = false;
            this.apply(mask => {
                for (let sampleId = 0; sampleId < mask.length; sampleId++) {
                    let bits = mask[sampleId] & ~removedBits;

                    for (const entry of dirtySamples) {
                        bits = entry.accepts && !entry.accepts(sampleId) ? bits | entry.bit : bits & ~entry.bit;
                    }

                    mask[sampleId] = bits;
                }
            }, eventFilters.length ? index => eventFilters.every(accepts => accepts(index)) : null);
        }

        this.notify();
    }
}
