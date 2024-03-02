export type V8CpuProfile = {
    startTime: number;
    endTime: number;
    nodes: V8CpuProfileNode[];
    timeDeltas: number[];
    samples: number[];
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

export type CpuProCallFrame = {
    id: number;
    scriptId: number;
    url: string | null;
    functionName: string;
    lineNumber: number;
    columnNumber: number;
    area: CpuProArea;
    package: CpuProPackage;
    module: CpuProModule;
    function: CpuProFunction;
};

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

export type CpuProArea = {
    id: number;
    name: string;
    selfTime: number;
    totalTime: number;
};

export type PackageType =
    | 'unknown'
    | WellKnownType
    | 'npm'
    | 'script'
    | 'regexp'
    | 'node'
    | 'webpack/runtime'
    | 'electron'
    | 'wasm'
    | 'chrome-extension'
    | 'internals';
export type CpuProPackage = {
    id: number; // starts with 1
    type: PackageType;
    name: string;
    path: string | null;
    area: CpuProArea;
    selfTime: number;
    totalTime: number;
    modules: CpuProModule[];
}

export type ModuleType =
    | 'unknown'
    | WellKnownType
    | 'regexp'
    | 'internals'
    | 'script'
    | 'electron'
    | 'webpack/runtime'
    | 'script'
    | 'script'
    | 'bundle'
    | 'node'
    | 'chrome-extension'
    | 'wasm'
    | `protocol-${string}`;
export type CpuProModule = {
    id: number; // starts with 1
    type: ModuleType;
    name: string | null;
    path: string | null;
    area: CpuProArea;
    package: CpuProPackage;
    packageRelPath: string | null;
    selfTime: number;
    totalTime: number;
    functions: CpuProFunction[];
};

export type CpuProFunction = {
    id: number; // starts with 1
    name: string;
    module: CpuProModule;
    regexp: string | null;
    loc: string | null;
    selfTime: 0;
    totalTime: 0;
};
