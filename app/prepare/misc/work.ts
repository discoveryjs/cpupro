export type WorkWrapper = <T>(name: string, fn: () => T) => Promise<T>;
export type WorkHandler = WorkWrapper & {
    withPrefix(prefix: string): WorkHandler;
};

export function createWorkHandler(wrapper: WorkWrapper): WorkHandler {
    return Object.assign(wrapper, {
        withPrefix(prefix: string) {
            return createWorkHandler((name, fn) =>
                wrapper(`${prefix} — ${name}`, fn)
            );
        }
    });
}

export const noopWorkHandler = createWorkHandler(
    async function noopWorkHandler<T>(name: string, fn: () => T): Promise<T> {
        return fn();
    });
