import { Dictionary } from './dictionary.js';

export type V8CpuProfileSet = {
    indexToView?: number;
    profiles: V8CpuProfile[];
}
export type V8CpuProfile = {
    startTime: number;
    endTime: number;
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[];
    timeDeltas: number[];
    samples: number[];
} & V8CpuProfileCpuproExtensions;
// FIXME: cpupro extensions (temporary)
export type V8CpuProfileCpuproExtensions = {
    _name?: string; // some profiles has a name
    _type?: 'memory' | 'time';
    _runtime?: RuntimeCode;
    _samplesInterval?: number;
    _samplePositions?: number[];
    _memoryGc?: number[];
    _memoryGcNames?: Record<number, string>;
    _memoryPos?: number[];
    _memoryType?: number[];
    _memoryTypeNames?: Record<number, string>;
    _memorySpace?: number[];
    _memorySpaceNames?: Record<number, string>;
    _callFrames?: V8CpuProfileCallFrame[];
    _callFrameCodes?: V8CpuProfileCallFrameCodes[];
    _scripts?: V8CpuProfileScript[];
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
    start?: number;
    end?: number;
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
export type V8CpuProfileCallFrameCodes = {
    callFrame: number;
    codes: V8CpuProfileCallFrameCode[]
}
export type V8CpuProfileCallFrameCode = {
    tm: number;
    tier: V8CallFrameCodeType;
    size: number;
    positions: string;
    inlined: string;
    fns: number[];
    disassemble: V8CpuProfileDisassemble | undefined;
    deopt: V8CpuProfileDeopt | undefined;
    ic: V8CpuProfileICEntry[] | undefined;
}
export type V8CpuProfileDisassemble = {
    kind: string;
    compiler: V8CallFrameCodeType | `Unknown(${string})`;
    instructions: string | null;
    sections: { header: string; content: string; }[];
    raw: string;
}
export type V8CpuProfileDeopt = {
    tm: number;
    inliningId: number;
    scriptOffset: number;
    posText: string;
    reason: string;
    bailoutType: string;
}
export type V8CpuProfileICEntry = {
    tm: number;
    type: string;
    inliningId: number;
    scriptOffset: number;
    oldState: string;
    newState: string;
    map: string;
    key: string;
    modifier: string;
    slowReason: string;
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
export type V8CallFrameCodeType =
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
    | '(logging)'
    | '(no samples)'
    | '(parser)'
    | '(bytecode compiler)'
    | '(compiler)'
    | '(atomics wait)'
    ;
export type WellKnownType =
    | 'root'
    | 'program'
    | 'gc'
    | 'idle'
    | 'logging'
    | 'no-samples'
    | 'parser'
    | 'bytecode-compiler'
    | 'compiler'
    | 'atomics-wait'
    ;

export type CpuProNode = CpuProCallFrame | CpuProModule | CpuProPackage | CpuProCategory | CpuProCallFramePosition;

export type GeneratedNodes = {
    count: number;
    dict: Dictionary;
    nodeIdSeed: number;
    noSamplesNodeId: number;
    callFrames: number[];
    nodeParentId: number[];
    parentScriptOffsets: number[];
}

export type CpuProCallFrameKind =
    | 'script'
    | 'function'
    | 'builtin'
    | 'ic'
    | 'bytecode'
    | 'cpp'
    | 'lib'
    | 'regexp'
    | 'vm-state'
    | 'root';
export type CpuProCallFrame = {
    id: number;
    script: CpuProScript | null;
    name: string;
    origName: string;
    kind: CpuProCallFrameKind;
    line: number;
    column: number;
    loc: string | null;
    start: number;
    end: number;
    regexp: string | null;
    module: CpuProModule;
    package: CpuProPackage;
    category: CpuProCategory;
}

export type CpuProCallFramePosition = {
    callFrame: CpuProCallFrame;
    scriptOffset: number;
}

export type ModuleType = // alphabetical order
    | 'blocking'
    | 'bundle'
    | 'chrome-extension'
    | 'compilation'
    | 'deno'
    | 'electron'
    | 'gc'
    | 'internals'
    | 'idle'
    | 'logging'
    | 'node'
    | 'program'
    | `protocol-${string}`
    | 'regexp'
    | 'root'
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
    script: CpuProScript | null;
    category: CpuProCategory;
    package: CpuProPackage;
    packageRelPath: string | null;
}

export type PackageType = // alphabetical order
    | 'blocking'
    | 'chrome-extension'
    | 'compilation'
    | 'deno'
    | 'electron'
    | 'gc'
    | 'idle'
    | 'internals'
    | 'logging'
    | 'node'
    | 'program'
    | 'devtools'
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
}
export type PackageProvider = {
    cdn: CDN;
    endpoints: PackageProviderEndpoint[];
}
export type CpuProPackage = {
    id: number; // starts with 1
    type: PackageType;
    name: string;
    shortName: string;
    version: string | null;
    registry: PackageRegistry | null;
    cdn: CDN | null;
    path: string | null;
    category: CpuProCategory;
}

export type CpuProCategory = {
    id: number;
    name: string;
}

export type CpuProScript = {
    id: number;
    url: string;
    module: CpuProModule;
    source: string | null;
    callFrames: CpuProCallFrame[];
}
export interface IProfileScriptsMap {
    get(scriptId: number | string): CpuProScript | undefined;
    has(scriptId: number | string): boolean;
    set(scriptId: number | string, script: CpuProScript): void;
    resolveScript(scriptId: number, url?: string | null, source?: string | null): CpuProScript | null;
    normalizeScriptId(scriptId: string | number): number;
}

export type CpuProCallFrameCodes = {
    callFrame: CpuProCallFrame;
    topTierWeight: number;
    topTier: V8CallFrameCodeType;
    hotness: 'cold' | 'warm' | 'hot';
    codes: CpuProCallFrameCode[];
}
export type CpuProCallFrameCode = {
    tm: number;
    callFrame: CpuProCallFrame;
    callFrameCodes: CpuProCallFrameCodes;
    tier: string;
    duration: number;
    positions: string;
    inlined: string;
    fns: CpuProCallFrame[];
    disassemble?: V8CpuProfileDisassemble;
}
