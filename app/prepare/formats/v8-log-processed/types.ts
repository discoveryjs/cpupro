export type V8LogProfile = {
    code: Code[];
    ticks: Tick[];
    functions: ProfileFunction[];
    scripts: Script[];
    heap?: {
        available: null | number;
        capacity: null | number;
        events: HeapEvent[];
    };
}

export type Code = {
    name: string;
    type: 'CODE' | 'CPP' | 'JS' | 'SHARED_LIB';
    timestamp?: number;
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
    tm?: number;
    source?: CodeSource;
    deopt?: Deopt;
}

export type CodeSource = {
    script: number;
    start: number;
    end: number;
    positions: string;
    inlined: string;
    fns: number[];
}

export type Deopt = {
    tm: number;
    inliningId: number;
    scriptOffset: number;
    posText: string;
    reason: string;
    bailoutType: string;
}

export type ProfileFunction = {
    name: string;
    codes: number[];
}

export type Tick = {
    tm: number;  // timestamp
    vm: number;  // vm state
    s: number[]; // stack
}

export type Script = {
    id: number;
    url: string;
    source: string;
}

export type CodeCallFrameInfo = {
    name: string;
    file?: string; // file path
    line?: number;
    column?: number;
    lowlevel?: boolean;
}

export type CallFrame = {
    scriptId: number;
    functionId?: number | null;
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
}

export type CallNode = {
    id: number;
    callFrame: CallFrame;
    children: number[];
    parentScriptOffset: number;
}

export type HeapEvent = {
    tm: number;
    event: 'new' | 'delete';
    address: string;
    size: number;
}
