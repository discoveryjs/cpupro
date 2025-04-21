export type ArgParser = (value: string) => string | number;
export enum CodeState {
    COMPILED = 'Builtin',
    IGNITION = 'Unopt',
    SPARKPLUG = 'Sparkplug',
    MAGLEV = 'Maglev',
    TURBOFAN = 'Opt'
}

export type Meta = {
    version?: string;
    platform?: string;
    heapCapacity?: number;
    heapAvailable?: number;
}

export type CodeSharedLib = {
    name: string;
    type: 'SHARED_LIB';
}

export type CodeCompiled = {
    name: string;
    timestamp: number;
    type: 'CODE';
    kind: string;
}

export type CodeJavaScript = {
    name: string;
    type: 'JS';
    kind: string;
    func: number;
    tm: number;
    source?: {
        script: number;
        start: number;
        end: number;
        positions: string;
        inlined: string;
        fns: number[];
    };
}

export type Code =
    | CodeSharedLib
    | CodeCompiled
    | CodeJavaScript;

export type SFI = {
    id: number;
    name: string;
    codes: number[];
}
export type HeapEvent = {
    tm: number;
    event: string;
    type: string;
    address: string;
    size?: number;
}
