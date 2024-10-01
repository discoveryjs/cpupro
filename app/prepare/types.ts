export type V8CpuProfile = {
    startTime: number;
    endTime: number;
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[];
    timeDeltas: number[];
    samples: number[];
} & V8CpuProfileCpuproExtensions;
// FIXME: cpupro extensions (temporary)
export type V8CpuProfileCpuproExtensions = {
    _runtime?: RuntimeCode;
    _samplesInterval?: number;
    _samplePositions?: number[];
    _callFrames?: V8CpuProfileCallFrame[];
    _scripts?: V8CpuProfileScript[];
    _functions?: V8CpuProfileFunction[];
    _functionCodes?: V8CpuProfileFunctionCodes[];
    _executionContexts?: V8CpuProfileExecutionContext[];
    _heap?: {
        available: null | number;
        capacity: null | number;
        events: V8HeapEvent[];
    };
}
export type V8CpuProfileNode<TCallFrame = V8CpuProfileCallFrame> = {
    id: number;
    callFrame: TCallFrame;
    children?: number[];
    parentScriptOffset?: number;
}
export type V8CpuProfileCallFrame = {
    scriptId: string | number;
    url: string | null;
    functionName: string | null;
    lineNumber: number;
    columnNumber: number;
}
export type V8CpuProfileExecutionContext = {
    origin: string;
    name: string;
}
export type V8CpuProfileScript = {
    id: number;
    url: string;
    source: string;
}
export type V8CpuProfileFunction = {
    scriptId: number;
    name: string;
    start: number;
    end: number;
    line: number;
    column: number;
}
export type V8CpuProfileFunctionCodes = {
    function: number;
    codes: V8CpuProfileFunctionCode[]
};
export type V8CpuProfileFunctionCode = {
    tm: number;
    tier: V8FunctionCodeType;
    positions: string;
    inlined: string;
    fns: number[];
    deopt: V8CpuProfileDeopt | undefined;
}
export type V8CpuProfileDeopt = {
    tm: number;
    inliningId: number;
    scriptOffset: number;
    posText: string;
    reason: string;
    bailoutType: string;
}
export type V8HeapEvent = {
    tm: number;
    event: 'new' | 'delete';
    address: string;
    size: number;
}

export type RuntimeCode =
    | 'chromium'
    | 'deno'
    | 'edge'
    | 'electron'
    | 'nodejs'
    | 'unknown'
    ;
export type V8FunctionCodeType =
    | 'Ignition'
    | 'Sparkplug'
    | 'Maglev'
    | 'Turboprop'
    | 'Turbofan'
    | 'Unknown'
    ;
export type WellKnownName =
    | '(root)'
    | '(program)'
    | '(garbage collector)'
    | '(idle)'
    | '(parser)'
    | '(compiler bytecode)'
    | '(compiler)'
    | '(atomics wait)'
    ;
export type WellKnownType =
    | 'root'
    | 'program'
    | 'gc'
    | 'idle'
    | 'parser'
    | 'compiler-bytecode'
    | 'compiler'
    | 'atomics-wait'
    ;

export type CpuProHierarchyNode = CpuProCategory | CpuProPackage | CpuProModule | CpuProFunction;
export type CpuProNode = CpuProCallFrame | CpuProHierarchyNode;

export type CpuProCallFrame = {
    id: number;
    scriptId: number;
    url: string | null;
    functionName: string;
    lineNumber: number;
    columnNumber: number;
    function: CpuProFunction;
    module: CpuProModule;
    package: CpuProPackage;
    category: CpuProCategory;
    script: CpuProScript | null;
};

export type CpuProScript = {
    id: number;
    url: string;
    module: CpuProModule | null;
    source: string;
    compilation: CpuProScriptFunction | null;
    functions: CpuProScriptFunction[];
}
export type CpuProScriptFunction = {
    id: number; // starts with 1
    name: string;
    script: CpuProScript | null;
    start: number;
    end: number;
    line: number;
    column: number;
    loc: string | null;
}
export type CpuProScriptCodes = {
    script: CpuProScript;
    compilation: CpuProFunctionCodes | null; // FIXME: find better name
    functionCodes: CpuProFunctionCodes[];
};
export type CpuProFunctionCodes = {
    function: CpuProScriptFunction;
    topTier: V8FunctionCodeType;
    hotness: 'cold' | 'warm' | 'hot';
    codes: CpuProFunctionCode[];
};
export type CpuProFunctionCode = {
    tm: number;
    function: CpuProScriptFunction;
    tier: string;
    duration: number;
    positions: string;
    inlined: string;
    fns: number[];
}

export type CpuProFunctionKind = 'script' | 'function' | 'regexp' | 'vm-state' | 'root';
export type CpuProFunction = {
    id: number; // starts with 1
    name: string;
    kind: CpuProFunctionKind;
    category: CpuProCategory;
    package: CpuProPackage;
    module: CpuProModule;
    regexp: string | null;
    loc: string | null;
};

export type ModuleType = // alphabetical order
    | WellKnownType
    | 'bundle'
    | 'chrome-extension'
    | 'deno'
    | 'electron'
    | 'compilation'
    | 'blocking'
    | 'internals'
    | 'node'
    | `protocol-${string}`
    | 'regexp'
    | 'script'
    | 'unknown'
    | 'v8'
    | 'wasm'
    | 'webpack/runtime'
    ;
export type CpuProModule = {
    id: number; // starts with 1
    type: ModuleType;
    name: string | null;
    path: string | null;
    category: CpuProCategory;
    package: CpuProPackage;
    packageRelPath: string | null;
};

export type PackageType = // alphabetical order
    | 'chrome-extension'
    | 'deno'
    | 'electron'
    | 'compilation'
    | 'blocking'
    | 'gc'
    | 'idle'
    | 'internals'
    | 'node'
    | 'program'
    | 'regexp'
    | 'root'
    | 'script'
    | 'unknown'
    | 'wasm'
    | 'webpack/runtime'
    ;
export type PackageRegistry = // alphabetical order
    | 'denoland'
    | 'github'
    | 'jsr'
    | 'npm'
    ;
export type CDN = // alphabetical order
    | 'denoland'
    | 'esmsh'
    | 'github'
    | 'jsdelivr'
    | 'jspm'
    | 'jsr'
    | 'unpkg'
    | 'npm'
    | 'skypack'
    ;
export type PackageProviderEndpoint = {
    registry: PackageRegistry;
    pattern: RegExp;
};
export type PackageProvider = {
    cdn: CDN;
    endpoints: PackageProviderEndpoint[];
}
export type CpuProPackage = {
    id: number; // starts with 1
    type: PackageType;
    name: string;
    version: string | null;
    registry: PackageRegistry | null;
    cdn: CDN | null;
    path: string | null;
    category: CpuProCategory;
};

export type CpuProCategory = {
    id: number;
    name: string;
};
