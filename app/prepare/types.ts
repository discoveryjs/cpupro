import { Dictionary } from './dictionary.js';
import { Ownership, UniformTraceEvent } from './formats/types.js';
import { Profile } from './profile.mjs';

export type V8CpuProfile = {
    startTime: number;
    endTime: number;
    nodes: V8CpuProfileNode[] | V8CpuProfileNode<number>[];
    timeDeltas: number[];
    samples: number[];
    trace_ids?: Record<string, number>;
    lines?: number[];
    columns?: number[];
} & V8CpuProfileCpuproExtensions;
// FIXME: cpupro extensions (temporary)
export type V8CpuProfileCpuproExtensions = {
    _name?: string | null; // some profiles has a name
    _pid?: number;
    _tid?: number;
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
    // Combined profile extensions (CPU + memory allocation data)
    _cpuproAllocationMapping?: number[]; // maps CPU sample index -> last allocation ID in range
    _cpuproAllocationIds?: number[]; // allocation IDs (ordinal)
    _cpuproAllocationSizes?: number[]; // allocation sizes
    _cpuproAllocationScriptIds?: Array<number | string>; // allocation script ids in profile-local domain
    _cpuproAllocationGc?: number[]; // GC state (lower 2 bits) + epoch (upper bits)
    _cpuproAllocationTypes?: number[]; // V8 map type IDs
    _cpuproAllocationTypeNames?: Record<number, string>; // human-readable type names
    _cpuproAllocationSpaces?: number[]; // V8 map space IDs
    _cpuproAllocationSpaceNames?: Record<number, string>; // human-readable space names
    _cpuproAllocationCodeType?: number[]; // V8 map code type IDs
    _cpuproAllocationCodeTypeNames?: Record<number, string>; // human-readable code type names
    _cpuproAllocationLocations?: number[]; // allocation script offsets
    _cpuproAllocationContextInfo?: number[]; // vm state + builtin id
    _cpuproAllocationBuiltinNames?: Record<number, string>; // human-readable builtin names
    _cpuproAllocationVmStateNames?: Record<number, string>; // human-readable vm state names
}
export type V8CpuProfileNode<TCallFrame = V8CpuProfileCallFrame> = {
    id: number;
    callFrame: TCallFrame;
    children?: number[];
    parentScriptOffset?: number;
    parentLineNumber?: number;
    parentColumnNumber?: number;
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
    sourceMapUrl?: string | null;
    sourceMap?: SourceMap | null;
    lineOffset?: number;
    columnOffset?: number;
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
    specialized: boolean | undefined;
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

export type RuntimeCode = // alphabetical order
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
    | '(unknown)'
    | '(root)'
    | '(garbage collector)'
    | '(program)'
    | '(internals)'
    | '(idle)'
    | '(no samples)'
    | '(parser)'
    | '(bytecode compiler)'
    | '(compiler)'
    | '(atomics wait)'
    | '(logging)'
    | '(idle external)'
    ;
export type WellKnownType = // alphabetical order
    | 'atomics-wait'
    | 'bytecode-compiler'
    | 'compiler'
    | 'internals'
    | 'gc'
    | 'idle-external'
    | 'idle'
    | 'logging'
    | 'no-samples'
    | 'parser'
    | 'program'
    | 'root'
    | 'unknown'
    ;

export type CpuProNode = CpuProCallFrame | CpuProModule | CpuProPackage | CpuProCategory | CpuProLocation;

export type CpuProSession = {
    name: string | null;
    runtime: RuntimeCode | null;
    startTime: string | null;
    source: string | null;
    dataOrigin: string | null;
    ownership: Ownership | null;
    processes: CpuProProcess[];
    defaultProcess: CpuProProcess | null;
    profiles: Profile[];
    defaultProfile: Profile | null;
    shared: {
        scripts: Dictionary['scripts'];
        locations: Dictionary['locations'];
        callFrames: Dictionary['callFrames'];
        modules: Dictionary['modules'];
        packages: Dictionary['packages'];
        categories: Dictionary['categories'];
    };
}
export type CpuProProcess = {
    pid: number | null;
    name: string | null;
    session: CpuProSession;
    threads: CpuProThread[];
}
export type CpuProThread = {
    pid: number | null;
    tid: number | null;
    name: string | null;
    process: CpuProProcess | null;
    profiles: Profile[];
    events: UniformTraceEvent[];
    userTimings: UniformTraceEvent[]; // subset of user defined events, e.g. cat="blink.user_timing" in Chromium traces
}

export type SourceMap = {
    version: string;
    mappings: string;
    sources: string[];
    names: string[];
    file: string;
    sourceRoot?: string;
    sourcesContent?: (string | null)[];
}

export type CpuProCallFrameKind = // alphabetical order
    | 'builtin'
    | 'bytecode'
    | 'cpp'
    | 'function'
    | 'ic'
    | 'lib'
    | 'regexp'
    | 'root'
    | 'script'
    | 'vm-state'
    | 'unknown'
    ;
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
    location: CpuProLocation | null;
    module: CpuProModule;
    package: CpuProPackage;
    category: CpuProCategory;
}

export type CpuProLocation = {
    id: number;
    callFrame: CpuProCallFrame;
    script: CpuProScript | null;
    scriptOffset: number; // -1 if not available
    line: number;          // -1 if not available
    column: number;        // -1 if not available
}

export type ModuleType = // alphabetical order
    | 'blocking'
    | 'bundle'
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
    owner: CpuProOwner;
}

export type PackageType = // alphabetical order
    | 'blocking'
    | 'chrome-extension'
    | 'compilation'
    | 'deno'
    | 'devtools'
    | 'electron'
    | 'gc'
    | 'idle'
    | 'internals'
    | 'logging'
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
    | 'npm'
    | 'skypack'
    | 'unpkg'
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

export type CpuProOwner = {
    id: number; // starts with 1
    name: string;
}

export type CpuProScript = {
    id: number;
    url: string;
    source: string | null;
    lineOffset: number;
    columnOffset: number;
    sourceMapUrl: string | null;
    sourceMap: SourceMap | null;
    module: CpuProModule;
    callFrames: CpuProCallFrame[];
    originalFor: CpuProScript | null;
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
    tier: V8CallFrameCodeType;
    duration: number;
    segments: { tm: number; duration: number }[] | null;
    positions: string;
    inlined: string;
    fns: CpuProCallFrame[];
    disassemble?: V8CpuProfileDisassemble;
}
