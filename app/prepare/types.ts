export type V8CpuProfile = {
    startTime: number;
    endTime: number;
    nodes: V8CpuProfileNode[];
    timeDeltas: number[];
    samples: number[];

    // FIXME: cpupro extensions (temporary)
    scripts?: V8CpuProfileScript[];
    scriptFunctions?: V8CpuProfileScriptFunction[];
};
export type V8CpuProfileNode = {
    id: number;
    callFrame: V8CpuProfileCallFrame;
    children?: number[];
}
export type V8CpuProfileCallFrame = {
    scriptId: string | number;
    url: string | null;
    functionName: string | null;
    lineNumber: number;
    columnNumber: number;
};
export type V8CpuProfileScript = {
    id: number;
    url: string;
    source: string;
}
export type V8CpuProfileScriptFunction = {
    id: number;
    name: string;
    script: number | null;
    line: number;
    column: number;
    start: number;
    end: number;
    states: V8CpuProfileScriptFunctionState[];
}
export type V8CpuProfileScriptFunctionState = {
    tm: number;
    tier: string;
    positions: string;
    inlined: string;
    fns: number[];
}

export type WellKnownName =
    | '(root)'
    | '(program)'
    | '(garbage collector)'
    | '(idle)'
    ;
export type WellKnownType =
    | 'root'
    | 'program'
    | 'gc'
    | 'idle'
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
};

export type CpuProScript = {
    id: number;
    url: string;
    module: CpuProModule | null;
    source: string;
    compilation: V8CpuProfileScriptFunctionState[] | null;
    functions: CpuProScriptFunction[];
}
export type CpuProScriptFunction = Omit<V8CpuProfileScriptFunction, 'script'> & {
    script: CpuProScript | null;
    loc: string | null;
    function: CpuProFunction | null;
    inlinedInto: CpuProScriptFunction[] | null;
};

export type CpuProFunction = {
    id: number; // starts with 1
    name: string;
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
    | 'engine'
    | 'internals'
    | 'node'
    | `protocol-${string}`
    | 'regexp'
    | 'script'
    | 'wasm'
    | 'webpack/runtime'
    | 'unknown'
    ;
export type CpuProModule = {
    id: number; // starts with 1
    type: ModuleType;
    name: string | null;
    path: string | null;
    category: CpuProCategory;
    package: CpuProPackage;
    packageRelPath: string | null;
    functions: CpuProFunction[];
};

export type PackageType = // alphabetical order
    | WellKnownType
    | 'chrome-extension'
    | 'deno'
    | 'electron'
    | 'engine'
    | 'internals'
    | 'node'
    | 'regexp'
    | 'script'
    | 'wasm'
    | 'webpack/runtime'
    | 'unknown'
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
    modules: CpuProModule[];
};

export type CpuProCategory = {
    id: number;
    name: string;
};
