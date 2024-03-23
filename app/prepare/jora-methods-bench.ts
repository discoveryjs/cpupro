export function trackExecutionTime(methods: Record<string, () => unknown>, trackMethodNames: string[]) {
    let scheduleTimingsLoggingBuffer = [[]];
    let scheduleTimingsLoggingFrameTimer = null;
    let scheduleTimingsLoggingTimer = null;
    let frameIdx = 0;

    for (const methodName of trackMethodNames) {
        const fn = methods[methodName];

        methods[methodName] = function(...args) {
            const startTime = Date.now();

            try {
                return fn.apply(this, args);
            } finally {
                scheduleTimingsLoggingBuffer.at(-1).push([`${methodName}() — ${Date.now() - startTime}ms`, args]);

                if (scheduleTimingsLoggingFrameTimer === null) {
                    scheduleTimingsLoggingFrameTimer = requestAnimationFrame(() => {
                        scheduleTimingsLoggingFrameTimer = null;
                        scheduleTimingsLoggingBuffer.push([]);
                    });
                }

                if (scheduleTimingsLoggingTimer === null) {
                    scheduleTimingsLoggingTimer = requestIdleCallback(() => {
                        const buffer = scheduleTimingsLoggingBuffer;

                        cancelAnimationFrame(scheduleTimingsLoggingFrameTimer);

                        scheduleTimingsLoggingFrameTimer = null;
                        scheduleTimingsLoggingTimer = null;
                        scheduleTimingsLoggingBuffer = [[]];

                        if (buffer.at(-1).length === 0) {
                            buffer.pop();
                        }

                        console.group('Jora methods timings');
                        for (const frame of buffer) {
                            console.group('Frame #' + ++frameIdx);
                            for (const entry of frame) {
                                console.log(...entry);
                            }
                            console.groupEnd();
                        }
                        console.groupEnd();
                    });
                }
            }
        };
    }
}
