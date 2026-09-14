import { Observer } from './misc.js';

export type FilterMode = 'exclude' | 'include';
export type FilterOption = { key: string; label: string; color?: string };
export type FilterDomain = 'sample' | 'event';
export type Acceptance = (index: number) => boolean;
export type PreparedAttributeFilter = {
    readonly key: string;
    readonly domain: FilterDomain;
    readonly size: number;
    readonly accepts: Acceptance | null;
};
export interface AttributeFilterSettings {
    readonly key: string;
    readonly label: string;
    readonly active: boolean;
    reset(): void;
    allowAll(): void;
    subscribe(callback: () => void): () => void;
}

export class SetAttributeFilter extends Observer implements AttributeFilterSettings {
    #mode: FilterMode = 'exclude';
    #selected = new Set<string>();
    #revision = 0;

    constructor(
        readonly key: string,
        readonly label: string,
        readonly options: FilterOption[]
    ) {
        super();
    }

    get active() {
        return this.#mode === 'include' || this.#selected.size > 0;
    }

    get revision() {
        return this.#revision;
    }

    addOptions(options: readonly FilterOption[]) {
        const keys = new Set(this.options.map(option => option.key));
        const previousLength = this.options.length;

        for (const option of options) {
            if (!keys.has(option.key)) {
                keys.add(option.key);
                this.options.push(option);
            }
        }

        if (this.options.length !== previousLength) {
            this.#revision++;
            this.notify();
        }
    }

    get mode(): FilterMode {
        return this.#mode;
    }

    get selectedKeys(): string[] {
        return [...this.#selected];
    }

    setSelection(mode: FilterMode, keys: Iterable<string>) {
        if (mode !== 'exclude' && mode !== 'include') {
            throw new Error(`Unknown filter mode ${mode}`);
        }

        const selected = new Set(keys);

        if (mode === this.#mode && selected.size === this.#selected.size && [...selected].every(key => this.#selected.has(key))) {
            return;
        }

        this.#mode = mode;
        this.#selected = selected;
        this.#revision++;
        this.notify();
    }

    isEnabled(key: string) {
        return this.#selected.has(key) === (this.#mode === 'include');
    }

    setEnabled(key: string, enabled: boolean) {
        if (!this.options.some(option => option.key === key)) {
            throw new Error(`Unknown option ${key} for filter ${this.key}`);
        }

        if (this.isEnabled(key) === enabled) {
            return;
        }

        if (enabled === (this.#mode === 'include')) {
            this.#selected.add(key);
        } else {
            this.#selected.delete(key);
        }

        this.#revision++;
        this.notify();
    }

    reset() {
        this.setSelection(this.#mode, []);
    }

    allowAll() {
        this.setSelection('exclude', []);
    }
}
