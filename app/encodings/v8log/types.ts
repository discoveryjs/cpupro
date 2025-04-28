export type ArgParser = (value: string) => string | number;
export enum CodeState {
    COMPILED = 'Builtin',
    IGNITION = 'Unopt',
    SPARKPLUG = 'Sparkplug',
    MAGLEV = 'Maglev',
    TURBOFAN = 'Opt'
}

export type ParseResult = {
    meta: Meta;
    code: Code[];
    functions: LogFunction[];
    ticks: Tick[];
    scripts: (Script | null)[];
    heap: Heap;

    ignoredOps?: string[];
    ignoredEntries?: unknown[];
}

export type Meta = {
    version?: string;
    platform?: string;
    samplesInterval?: number;
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
    size: number;
}
export type CodeJavaScript = {
    name: string;
    type: 'JS';
    kind: string;
    size: number;
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

export type LogFunction = {
    name: string;
    codes: number[];
}

export type SFI = {
    id: number;
    name: string;
    codes: number[];
}

export type Tick = {
    tm: number;
    vm: number;
    s: number[];
}

export type Script = {
    id: number;
    url: string;
    source: string;
}

export type Heap = {
    capacity?: number;
    available?: number;
    events: HeapEvent[];
}
export type HeapEvent = {
    tm: number;
    event: string;
    type: string;
    address: string;
    size?: number;
}
