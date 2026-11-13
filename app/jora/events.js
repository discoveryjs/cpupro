import { namedEvents as namedEventIndices } from '../prepare/preprocessing/thread-events.js';

export const methods = {
    // Events of a thread with any of the names, in their order
    namedEvents(thread, names) {
        const indices = namedEventIndices(thread.events, names);
        const events = [];

        for (let i = 0; i < indices.length; i++) {
            events.push(thread.events[indices[i]]);
        }

        return events;
    },

    eventsTimeline(threads, selectedIntervals = []) {
        const colors = new Map(selectedIntervals.map(({ name, color }) => [name, color]));
        const groups = [];
        let minX;
        let maxX;

        for (const thread of threads || []) {
            const spans = [];
            const intervals = [];

            for (const event of thread.events || []) {
                const { tm, duration, name } = event;
                const end = tm + duration;

                if (tm > 0) {
                    minX = minX === undefined ? tm : Math.min(minX, tm);

                    if (duration !== -1) {
                        maxX = maxX === undefined ? end : Math.max(maxX, end);
                    }

                    if (duration > 0 && name !== 'Animation') {
                        spans.push({
                            start: tm,
                            end,
                            text: name + (name === 'EventDispatch' ? ' / ' + event.data?.type : ''),
                            event
                        });
                    }
                }

                const color = colors.get(name);

                if (color) {
                    intervals.push({ start: tm, end, text: name, color });
                }
            }

            groups.push({
                name: `${thread.name} (pid:${thread.pid} tid:${thread.tid})`,
                spans,
                intervals
            });
        }

        return { spans: groups, minX, maxX: maxX === undefined ? NaN : maxX };
    }
};
