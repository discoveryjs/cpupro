// A view of a typed array that records the index of every element read. Methods are bound to the array itself,
// since typed array methods reject a proxy receiver
export function trackReads<T extends Uint32Array | Float64Array>(array: T) {
    const reads: number[] = [];
    const get = (target: T, property: string | symbol) => {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
            reads.push(Number(property));
        }

        const value = Reflect.get(target, property, target);

        return typeof value === 'function' ? value.bind(target) : value;
    };

    return {
        array: new Proxy(array, { get }),
        reads
    };
}
