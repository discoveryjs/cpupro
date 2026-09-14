import { Observer } from './misc.js';

export type FilterDomain = 'sample' | 'event';
export type Acceptance = (index: number) => boolean;
export type FilterOption = { key: string; label: string; color?: string };
export interface AttributeFilter {
    readonly key: string;
    readonly label: string;
    readonly domain: FilterDomain;
    readonly size: number;
    readonly active: boolean;
    compile(): Acceptance;
    reset(): void;
    subscribe(callback: () => void): () => void;
}
type FilterEntry = {
    filter: AttributeFilter;
    bit: number;
    dirty: boolean;
    accepts: Acceptance | null;
    unsubscribe: () => void;
};
type ApplyFilters = (updateMask: (mask: Uint32Array) => void, acceptsEvent: Acceptance | null) => void;

export class SetAttributeFilter extends Observer implements AttributeFilter {
    #excluded = new Set<string>();

    constructor(
        readonly key: string,
        readonly label: string,
        readonly domain: FilterDomain,
        readonly size: number,
        readonly options: readonly FilterOption[],
        private readonly valueIndex: (index: number) => number
    ) {
        super();
    }

    get active() {
        return this.#excluded.size > 0;
    }

    get excludedKeys(): string[] {
        return [...this.#excluded];
    }

    setExcludedKeys(keys: Iterable<string>) {
        const excluded = new Set(keys);

        if (excluded.size === this.#excluded.size && [...excluded].every(key => this.#excluded.has(key))) {
            return;
        }

        this.#excluded = excluded;
        this.notify();
    }

    isEnabled(key: string) {
        return !this.#excluded.has(key);
    }

    setEnabled(key: string, enabled: boolean) {
        if (!this.options.some(option => option.key === key)) {
            throw new Error(`Unknown option ${key} for filter ${this.key}`);
        }

        if (this.isEnabled(key) === enabled) {
            return;
        }

        if (enabled) {
            this.#excluded.delete(key);
        } else {
            this.#excluded.add(key);
        }

        this.notify();
    }

    reset() {
        if (this.#excluded.size) {
            this.#excluded.clear();
            this.notify();
        }
    }

    compile(): Acceptance {
        const allowed = Uint8Array.from(
            this.options,
            option => this.isEnabled(option.key) ? 1 : 0
        );

        return index => allowed[this.valueIndex(index)] === 1;
    }
}

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

    get filters(): AttributeFilter[] {
        return [...this.#entries.values()]
            .map(entry => entry.filter);
    }

    get(key: string) {
        return this.#entries.get(key)?.filter;
    }

    add(filter: AttributeFilter) {
        if (this.#entries.has(filter.key)) {
            throw new Error(`Filter ${filter.key} is already registered`);
        }

        if (filter.size !== (filter.domain === 'sample' ? this.sampleCount : this.eventCount)) {
            throw new Error(`Filter ${filter.key} has an incompatible ${filter.domain} domain`);
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
            accepts: null,
            unsubscribe: () => {}
        };

        this.#entries.set(filter.key, entry);
        entry.unsubscribe = filter.subscribe(() => {
            entry.dirty = true;
            this.#schedule();
        });
        this.#schedule();

        return filter;
    }

    remove(key: string) {
        const entry = this.#entries.get(key);

        if (!entry) {
            return;
        }

        entry.unsubscribe();
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

    reset() {
        this.batch(() => {
            for (const { filter } of this.#entries.values()) {
                filter.reset();
            }
        });
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

                entry.accepts = entry.filter.active ? entry.filter.compile() : null;
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
