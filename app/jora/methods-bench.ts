const safeRequestIdleCallback = typeof requestIdleCallback === 'function'
    ? requestIdleCallback
    : (fn: () => void) => setTimeout(fn, 100);

export function trackExecutionTime<T extends Record<string,(...args: unknown[]) => unknown>>(methods: T, trackMethodNames: (keyof T & string)[]) {
    let scheduleTimingsLoggingBuffer: [label: string, ...unknown[]][][] = [[]];
    let scheduleTimingsLoggingFrameTimer: number | null = null;
    let scheduleTimingsLoggingTimer: ReturnType<typeof safeRequestIdleCallback> | null = null;
    let frameIdx = 0;

    for (const methodName of trackMethodNames) {
        const fn = methods[methodName];

        methods[methodName] = function(...args) {
            const startTime = Date.now();

            try {
                return fn.apply(this, args);
            } finally {
                scheduleTimingsLoggingBuffer.at(-1)?.push([`${methodName}() — ${Date.now() - startTime}ms`, args]);

                if (scheduleTimingsLoggingFrameTimer === null) {
                    scheduleTimingsLoggingFrameTimer = requestAnimationFrame(() => {
                        scheduleTimingsLoggingFrameTimer = null;
                        scheduleTimingsLoggingBuffer.push([]);
                    });
                }

                if (scheduleTimingsLoggingTimer === null) {
                    scheduleTimingsLoggingTimer = safeRequestIdleCallback(() => {
                        const buffer = scheduleTimingsLoggingBuffer;

                        cancelAnimationFrame(scheduleTimingsLoggingFrameTimer as number);

                        scheduleTimingsLoggingFrameTimer = null;
                        scheduleTimingsLoggingTimer = null;
                        scheduleTimingsLoggingBuffer = [[]];

                        if (buffer.at(-1)?.length === 0) {
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
        } as T[typeof methodName];
    }
}
