export type ArgParser = (value: string) => string | number;
export enum CodeState {
    COMPILED = 'Buildin',
    IGNITION = 'Ignition',
    SPARKPLUG = 'Sparkplug',
    MAGLEV = 'Maglev',
    TURBOFAN = 'Turbofan'
}

export type Meta = {
    version?: string;
    platform?: string;
    heapCapacity?: number;
    heapAvailable?: number;
};
