import { Observer } from './misc.js';
import type { AttributeFilterSettings } from './attribute-filter.js';

type FilterEntry = { settings: AttributeFilterSettings; unsubscribe: () => void };

export class FilterSet extends Observer {
    #entries = new Map<string, FilterEntry>();
    #depth = 0;
    #pending = false;

    get filters() {
        return [...this.#entries.values()].map(entry => entry.settings);
    }

    get(key: string) {
        return this.#entries.get(key)?.settings;
    }

    add<Settings extends AttributeFilterSettings>(settings: Settings): Settings {
        if (this.#entries.has(settings.key)) {
            throw new Error(`Filter ${settings.key} is already defined`);
        }

        this.#entries.set(settings.key, {
            settings,
            unsubscribe: settings.subscribe(() => this.#changed())
        });
        this.#changed();

        return settings;
    }

    remove(key: string) {
        const entry = this.#entries.get(key);

        if (entry) {
            entry.unsubscribe();
            this.#entries.delete(key);
            this.#changed();
        }
    }

    batch(update: () => void) {
        this.#depth++;
        try {
            update();
        } finally {
            if (--this.#depth === 0 && this.#pending) {
                this.#pending = false;
                this.notify();
            }
        }
    }

    reset() {
        this.batch(() => this.filters.forEach(filter => filter.reset()));
    }

    allowAll() {
        this.batch(() => this.filters.forEach(filter => filter.allowAll()));
    }

    #changed() {
        if (this.#depth) {
            this.#pending = true;
        } else {
            this.notify();
        }
    }
}
