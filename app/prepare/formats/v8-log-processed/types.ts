export type NumericArray = Uint32Array | Int32Array | Uint16Array | Int16Array | number[];

export type V8LogProfile = {
    code: V8LogCode[];
    ticks: V8LogTick[];
    functions: V8LogFunction[];
    scripts: V8LogScripts;
    heap?: {
        available: null | number;
        capacity: null | number;
        events: V8LogHeapEvent[];
    };
}

export type V8LogCode = {
    name: string;
    type: 'CODE' | 'CPP' | 'JS' | 'SHARED_LIB';
    kind?:
        | 'Bultin'
        | 'BytecodeHandler'
        | 'Handler'
        | 'KeyedLoadIC'
        | 'KeyedStoreIC'
        | 'LoadGlobalIC'
        | 'LoadIC'
        | 'Opt'
        | 'StoreIC'
        | 'Stub'
        | 'Unopt'
        | 'Ignition'
        | 'Baseline'
        | 'Sparkplug'
        | 'Maglev'
        | 'Turboprop'
        | 'Turbofan'
        | 'Builtin'
        | 'RegExp';
    func?: number;
    size?: number;
    tm?: number;
    source?: V8LogCodeSource;
    deopt?: V8LogDeopt;
    ic?: V8LogICEntry[];
}

export type V8LogCodeSource = {
    script: number;
    start: number;
    end: number;
    positions: string;
    inlined: string;
    fns: number[];
}

export type V8LogDeopt = {
    tm: number;
    inliningId: number;
    scriptOffset: number;
    posText: string;
    reason: string;
    bailoutType: string;
}

export type V8LogICEntry = {
    tm: number;
    type: string;
    offset: number;
    oldState: string;
    newState: string;
    map: string;
    key: string;
    modifier: string;
    slowReason: string;
}

export type V8LogFunction = {
    name: string;
    codes: number[];
}

export type V8LogTick = {
    tm: number;  // timestamp
    vm: number;  // vm state
    s: number[]; // stack
}

export type V8LogScripts = (V8LogScript | null)[];
export type V8LogScript = {
    id: number;
    url: string;
    source: string;
}

export type V8LogHeapEvent = {
    tm: number;
    event: 'new' | 'delete';
    address: string;
    size: number;
}

// Output

export type CallFrame = {
    scriptId: number;
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
    start: number;
    end: number;
}

export type CallNode<TCallFrame = CallFrame> = {
    id: number;
    callFrame: TCallFrame;
    children: number[];
    parentScriptOffset: number;
}

export type CodePositionTable = {
    fistCode: number;
    lastCode: number;
    pcOnNextInstruction: boolean;
    positions: number[];
    inlined: number[] | null;
    fns: number[] | null;
}
