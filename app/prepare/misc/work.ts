import { now, perfMeasure } from './time-utils.js';

export type WorkWrapper = <T>(name: string, fn: () => T) => Promise<T>;
export type WorkWrapperChain = <T>(identity: WorkIdentity, fn: () => T) => Promise<T>;
export type WorkHandler = WorkWrapper & {
    withPrefix(prefix: string): WorkHandler;
    measure<T>(name: string, fn: () => T): Promise<T>;
};
export type WorkIdentity = {
    prefix?: string;
    name: string;
};

export function createWorkHandler(wrapper: WorkWrapperChain): WorkHandler {
    return Object.assign(<T>(name: string, fn: () => T) => wrapper({ name }, fn), {
        withPrefix(newPrefix: string) {
            return createWorkHandler(({ name, prefix }, fn) =>
                wrapper({
                    prefix: prefix ? `${newPrefix} — ${prefix}` : newPrefix,
                    name
                }, fn)
            );
        },
        async measure<T>(name: string, fn: () => T): Promise<T> {
            const startTime = now();

            try {
                return await fn();
            } finally {
                // use end:now() since Chromium's performance.measure() implementation is not accurate enough
                // when end is not specified
                perfMeasure(name, { start: startTime, end: now() });
            }
        }
    });
}

export const noopWorkHandler = createWorkHandler(
    async function noopWorkHandler<T>(identity: WorkIdentity, fn: () => T): Promise<T> {
        return fn();
    });
