export const utils = {
    isArray(value: unknown) {
        return Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView));
    }
};
