export type V8CpuProfile = {
    startTime: number;
    endTime: number;
    nodes: V8CpuProfileNode[];
    timeDeltas: number[];
    samples: number[];

    // FIXME: cpupro extensions (temporary)
    scripts?: V8CpuProfileScript[];
    functions?: V8CpuProfileFunction[];
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
export type V8CpuProfileFunction = {
    id: number;
    name: string;
    script: number | null;
    line: number;
    column: number;
    start: number;
    end: number;
    states: {
        tm: number;
        tier: string;
        positions: string;
        inlined: string;
        fns: number[];
    }[];
}

export type WellKnownName =
    | '(root)'
    | '(program)'
    | '(idle)'
    | '(garbage collector)';
export type WellKnownType =
    | 'root'
    | 'program'
    | 'idle'
    | 'gc';

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
    source: string;
    functions: CpuProScriptFunction[];
}
export type CpuProScriptFunction = Omit<V8CpuProfileFunction, 'script'> & {
    script: CpuProScript | null;
    loc: string | null;
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

export type ModuleType =
    | 'unknown'
    | 'engine'
    | WellKnownType
    | 'script'
    | 'wasm'
    | 'regexp'
    | 'internals'
    | 'bundle'
    | 'node'
    | 'deno'
    | 'electron'
    | 'webpack/runtime'
    | 'chrome-extension'
    | `protocol-${string}`;
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

export type PackageType =
    | 'unknown'
    | 'engine'
    | WellKnownType
    | 'script'
    | 'wasm'
    | 'regexp'
    | 'internals'
    | 'node'
    | 'deno'
    | 'electron'
    | 'webpack/runtime'
    | 'chrome-extension';
export type PackageRegistry =
    | 'npm'
    | 'jsr'
    | 'denoland';
export type CpuProPackage = {
    id: number; // starts with 1
    type: PackageType;
    name: string;
    version: string | null;
    registry: PackageRegistry | null;
    path: string | null;
    category: CpuProCategory;
    modules: CpuProModule[];
};

export type CpuProCategory = {
    id: number;
    name: string;
};
