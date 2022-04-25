type EventMap = {
    [key: string]: (...args: any[]) => void
};
type Listener<Callback> = {
    callback: Callback,
    next: Listener<Callback>
};

export class EventEmitter<Events extends EventMap> {
    listeners: {
        [EventName in keyof Events]: Listener<Events[EventName]>
    };

    constructor() {
        this.listeners = Object.create(null);
    }

    on<E extends keyof Events>(event: E, callback: Events[E]) {
        this.listeners[event] = {
            callback,
            next: this.listeners[event] || null
        };

        return this;
    }

    once<E extends keyof Events>(event: E, callback: Events[E]) {
        return this.on(event, function wrapper(...args) {
            callback.apply(this, args);
            this.off(event, wrapper);
        } as Events[E]);
    }

    off<E extends keyof Events>(event: E, callback: Events[E]) {
        let cursor = this.listeners[event] || null;
        let prev = null;

        // search for a callback and remove it
        while (cursor !== null) {
            if (cursor.callback === callback) {
                // make it non-callable
                cursor.callback = null;

                // remove from a list
                if (prev) {
                    prev.next = cursor.next;
                } else {
                    this.listeners[event] = cursor.next;
                }

                break;
            }

            prev = cursor;
            cursor = cursor.next;
        }

        return this;
    }

    emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>) {
        let cursor = this.listeners[event] || null;
        let hadListeners = false;

        while (cursor !== null) {
            if (typeof cursor.callback === 'function') {
                cursor.callback.apply(this, args);
            }

            hadListeners = true;
            cursor = cursor.next;
        }

        return hadListeners;
    }
}
