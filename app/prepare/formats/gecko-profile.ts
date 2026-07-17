import type {
    RuntimeCode,
    V8CpuProfile,
    V8CpuProfileCallFrame,
    V8CpuProfileNode,
    V8CpuProfileSet
} from '../types.js';

type JsonObject = Record<string, unknown>;

const cynicExecutableNames = new Set([
    'cynic',
    'cynic-bench',
    'cynic-fuzz',
    'cynic-test262',
    'cynic-test262-safe',
    'cynic-wasm-bench',
    'cynic-wasm-testsuite'
]);
const MAX_EXPANDED_SAMPLES = 10_000_000;

type GeckoMeta = {
    initialSelectedThreads?: number[];
    interval?: number;
    preprocessedProfileVersion: number;
    product?: string;
    sampleUnits?: {
        time?: string;
    };
};

type GeckoLib = {
    debugName?: string;
    debugPath?: string;
    name?: string;
    path?: string;
};

type GeckoTable = JsonObject & {
    length: number;
};

type GeckoSamples = GeckoTable & {
    stack: (number | null)[];
    time?: number[];
    timeDeltas?: number[];
    weight?: number[] | null;
    weightType?: string;
};

type GeckoTables = {
    frameTable: GeckoTable;
    funcTable: GeckoTable;
    resourceTable: GeckoTable;
    sources?: GeckoTable;
    stackTable: GeckoTable;
    stringArray: string[];
};

type GeckoThread = JsonObject & {
    frameTable?: GeckoTable;
    funcTable?: GeckoTable;
    isMainThread?: boolean;
    name?: string;
    processName?: string;
    processShutdownTime?: number | null;
    resourceTable?: GeckoTable;
    samples: GeckoSamples;
    sources?: GeckoTable;
    stackTable?: GeckoTable;
    stringArray?: string[];
    unregisterTime?: number | null;
};

export type GeckoProfile = {
    libs: GeckoLib[];
    meta: GeckoMeta;
    shared?: Partial<GeckoTables>;
    threads: GeckoThread[];
};

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null;
}

function isTable(value: unknown): value is GeckoTable {
    return isObject(value) && Number.isInteger(value.length) && Number(value.length) >= 0;
}

function isSamples(value: unknown): value is GeckoSamples {
    return isTable(value) &&
        Array.isArray(value.stack) &&
        (Array.isArray(value.time) || Array.isArray(value.timeDeltas));
}

function isTables(value: unknown): value is GeckoTables {
    return isObject(value) &&
        isTable(value.frameTable) &&
        isTable(value.funcTable) &&
        isTable(value.resourceTable) &&
        isTable(value.stackTable) &&
        Array.isArray(value.stringArray);
}

function resolveTables(shared: unknown, thread: unknown): GeckoTables | null {
    if (!isObject(thread)) {
        return null;
    }

    const sharedTables = isObject(shared) ? shared : {};
    const tables = {
        frameTable: sharedTables.frameTable ?? thread.frameTable,
        funcTable: sharedTables.funcTable ?? thread.funcTable,
        resourceTable: sharedTables.resourceTable ?? thread.resourceTable,
        sources: sharedTables.sources ?? thread.sources,
        stackTable: sharedTables.stackTable ?? thread.stackTable,
        stringArray: sharedTables.stringArray ?? thread.stringArray
    };

    return isTables(tables) ? tables : null;
}

/** Firefox Profiler's processed Gecko profile format, also emitted by Samply. */
export function isGeckoProfile(data: unknown): data is GeckoProfile {
    if (!isObject(data) || !isObject(data.meta) || !Array.isArray(data.libs) || !Array.isArray(data.threads)) {
        return false;
    }

    if (!data.libs.every(isObject) || !data.threads.every(isObject)) {
        return false;
    }

    if (!Number.isInteger(data.meta.preprocessedProfileVersion)) {
        return false;
    }

    if (isObject(data.meta.sampleUnits) &&
        typeof data.meta.sampleUnits.time === 'string' &&
        data.meta.sampleUnits.time !== 'ms') {
        return false;
    }

    return data.threads.some(thread =>
        isObject(thread) &&
        isSamples(thread.samples) &&
        resolveTables(data.shared, thread) !== null
    );
}

function column(table: GeckoTable, name: string): unknown[] {
    const value = table[name];

    if (!Array.isArray(value)) {
        throw new Error(`Gecko profile table is missing the ${name} column`);
    }

    return value;
}

function optionalColumn(table: GeckoTable | undefined, name: string): unknown[] | undefined {
    const value = table?.[name];
    return Array.isArray(value) ? value : undefined;
}

function indexAt(column: unknown[] | undefined, index: number): number | null {
    const value = column?.[index];
    return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function stringAt(strings: string[], index: unknown): string | null {
    return Number.isInteger(index) && Number(index) >= 0 && typeof strings[Number(index)] === 'string'
        ? strings[Number(index)]
        : null;
}

function zeroBasedLocation(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value) - 1
        : -1;
}

function micros(value: number): number {
    if (!Number.isFinite(value)) {
        throw new Error('Gecko profile contains a non-finite timestamp');
    }

    return Math.max(0, Math.round(value * 1000));
}

function sampleTimeDeltas(samples: GeckoSamples): number[] {
    if (Array.isArray(samples.timeDeltas)) {
        return samples.timeDeltas;
    }

    if (!Array.isArray(samples.time)) {
        throw new Error('Gecko profile samples have no timestamps');
    }

    let previous = 0;

    return samples.time.map(timestamp => {
        const delta = timestamp - previous;
        previous = timestamp;
        return delta;
    });
}

function tablesForThread(profile: GeckoProfile, thread: GeckoThread): GeckoTables {
    const tables = resolveTables(profile.shared, thread);

    if (tables === null) {
        throw new Error('Gecko profile thread has no processed stack tables');
    }

    return tables;
}

function hasSamples(thread: GeckoThread): boolean {
    return isSamples(thread.samples) && thread.samples.stack.length > 0;
}

function selectedThread(profile: GeckoProfile): GeckoThread {
    const selectedIndexes = Array.isArray(profile.meta.initialSelectedThreads)
        ? profile.meta.initialSelectedThreads
        : [];
    const selected = selectedIndexes
        .map(index => profile.threads[index])
        .filter((thread): thread is GeckoThread => thread !== undefined && hasSamples(thread));
    const candidates = selected.length > 0
        ? selected
        : profile.threads.filter(hasSamples);

    if (candidates.length === 0) {
        throw new Error('Gecko profile contains no sampled threads');
    }

    return candidates.reduce((best, thread) =>
        thread.samples.stack.length > best.samples.stack.length ? thread : best
    );
}

function normalizedRuntimeName(name: unknown): string {
    if (typeof name !== 'string') {
        return '';
    }

    const basename = name.trim().split(/[\\/]/).pop()?.toLowerCase() || '';

    return basename.endsWith('.exe') ? basename.slice(0, -4) : basename;
}

function runtimeForName(name: unknown): RuntimeCode | null {
    const normalizedName = normalizedRuntimeName(name);

    if (
        normalizedName === 'firefox' ||
        normalizedName === 'firefox-bin' ||
        normalizedName === 'firefox nightly' ||
        normalizedName === 'firefox developer edition'
    ) {
        return 'firefox';
    }

    if (cynicExecutableNames.has(normalizedName)) {
        return 'cynic';
    }

    return null;
}

function detectGeckoRuntime(profile: GeckoProfile, thread: GeckoThread): RuntimeCode {
    const candidates = [
        thread.processName,
        ...profile.libs.flatMap(lib => [lib.name, lib.path, lib.debugName, lib.debugPath]),
        profile.meta.product
    ];

    for (const candidate of candidates) {
        const runtime = runtimeForName(candidate);

        if (runtime !== null) {
            return runtime;
        }
    }

    return 'unknown';
}

function urlForFunction(
    profile: GeckoProfile,
    tables: GeckoTables,
    functionIndex: number
): string | null {
    const { funcTable, resourceTable, sources, stringArray } = tables;
    const sourceIndex = indexAt(optionalColumn(funcTable, 'source'), functionIndex);

    if (sourceIndex !== null) {
        const filename = stringAt(stringArray, optionalColumn(sources, 'filename')?.[sourceIndex]);

        if (filename !== null) {
            return filename;
        }
    }

    const filename = stringAt(stringArray, optionalColumn(funcTable, 'fileName')?.[functionIndex]);

    if (filename !== null) {
        return filename;
    }

    const resourceIndex = indexAt(optionalColumn(funcTable, 'resource'), functionIndex);

    if (resourceIndex === null) {
        return null;
    }

    const libIndex = indexAt(optionalColumn(resourceTable, 'lib'), resourceIndex);
    const lib = libIndex !== null ? profile.libs[libIndex] : undefined;

    if (typeof lib?.path === 'string' && lib.path !== '') {
        return lib.path;
    }

    if (typeof lib?.name === 'string' && lib.name !== '') {
        return lib.name;
    }

    return stringAt(stringArray, optionalColumn(resourceTable, 'name')?.[resourceIndex]);
}

function callFrameForFrame(
    profile: GeckoProfile,
    tables: GeckoTables,
    frameIndex: number
): V8CpuProfileCallFrame {
    const { frameTable, funcTable, stringArray } = tables;
    const functionIndex = indexAt(column(frameTable, 'func'), frameIndex);

    if (functionIndex === null || functionIndex >= funcTable.length) {
        throw new Error(`Gecko profile frame ${frameIndex} has an invalid function index`);
    }

    const name = stringAt(stringArray, column(funcTable, 'name')[functionIndex]);
    const address = optionalColumn(frameTable, 'address')?.[frameIndex];
    const functionName = name || (
        typeof address === 'number' && address >= 0 ? `0x${address.toString(16)}` : '(unknown)'
    );
    const url = urlForFunction(profile, tables, functionIndex);
    const line = optionalColumn(frameTable, 'line')?.[frameIndex] ??
        optionalColumn(funcTable, 'lineNumber')?.[functionIndex];
    const columnNumber = optionalColumn(frameTable, 'column')?.[frameIndex] ??
        optionalColumn(funcTable, 'columnNumber')?.[functionIndex];

    return {
        scriptId: url || '0',
        url,
        functionName,
        lineNumber: zeroBasedLocation(line),
        columnNumber: zeroBasedLocation(columnNumber)
    };
}

function convertThread(profile: GeckoProfile, thread: GeckoThread): V8CpuProfile {
    if (thread.samples.weightType !== undefined && thread.samples.weightType !== 'samples') {
        throw new Error(
            `Gecko profile has unsupported sample weight type "${thread.samples.weightType}"`
        );
    }

    const tables = tablesForThread(profile, thread);
    const stackFrames = column(tables.stackTable, 'frame');
    const stackPrefixes = optionalColumn(tables.stackTable, 'prefix');
    const stackPrefixOffsets = optionalColumn(tables.stackTable, 'prefixOffset');
    const stackLength = tables.stackTable.length;
    const children = Array.from({ length: stackLength + 1 }, () => [] as number[]);
    const nodes: V8CpuProfileNode[] = [];

    for (let stackIndex = 0; stackIndex < stackLength; stackIndex++) {
        const frameIndex = indexAt(stackFrames, stackIndex);
        const prefix = stackPrefixes?.[stackIndex];
        const prefixOffset = stackPrefixOffsets?.[stackIndex];

        if (frameIndex === null || frameIndex >= tables.frameTable.length) {
            throw new Error(`Gecko profile stack ${stackIndex} has an invalid frame index`);
        }

        let parentId: number | null = null;

        if (stackPrefixes !== undefined) {
            parentId = prefix === null
                ? 1
                : Number.isInteger(prefix) && Number(prefix) >= 0 && Number(prefix) < stackIndex
                    ? Number(prefix) + 2
                    : null;
        } else if (stackPrefixOffsets !== undefined) {
            parentId = prefixOffset === 0
                ? 1
                : Number.isInteger(prefixOffset) && Number(prefixOffset) > 0 && Number(prefixOffset) <= stackIndex
                    ? stackIndex - Number(prefixOffset) + 2
                    : null;
        }

        if (parentId === null) {
            throw new Error(`Gecko profile stack ${stackIndex} has an invalid prefix`);
        }

        children[parentId - 1].push(stackIndex + 2);
        nodes.push({
            id: stackIndex + 2,
            callFrame: callFrameForFrame(profile, tables, frameIndex)
        });
    }

    nodes.unshift({
        id: 1,
        callFrame: {
            scriptId: '0',
            url: '',
            functionName: '(root)',
            lineNumber: -1,
            columnNumber: -1
        }
    });

    for (let i = 0; i < nodes.length; i++) {
        if (children[i].length > 0) {
            nodes[i].children = children[i];
        }
    }

    const rawTimeDeltas = sampleTimeDeltas(thread.samples);

    if (thread.samples.stack.length !== rawTimeDeltas.length) {
        throw new Error('Gecko profile sample stack and timestamp columns have different lengths');
    }

    const weights = thread.samples.weight;

    if (weights !== undefined && weights !== null && (
        !Array.isArray(weights) || weights.length !== thread.samples.stack.length
    )) {
        throw new Error('Gecko profile sample stack and weight columns have different lengths');
    }

    let expandedSampleCount = 0;

    for (let sampleIndex = 0; sampleIndex < thread.samples.stack.length; sampleIndex++) {
        const weight = weights?.[sampleIndex] ?? 1;

        if (!Number.isSafeInteger(weight) || weight <= 0) {
            throw new Error(`Gecko profile has unsupported sample weight ${weight}`);
        }

        expandedSampleCount += weight;

        // V8 CPU profiles have no sample-weight column, so expansion is required.
        // Bound it so a tiny input cannot force an unbounded output allocation.
        if (expandedSampleCount > MAX_EXPANDED_SAMPLES) {
            throw new Error(`Gecko profile expands beyond ${MAX_EXPANDED_SAMPLES} samples`);
        }
    }

    const samples = new Array<number>(expandedSampleCount);
    const timeDeltas = new Array<number>(expandedSampleCount);
    let expandedIndex = 0;

    for (let sampleIndex = 0; sampleIndex < thread.samples.stack.length; sampleIndex++) {
        const stackIndex = thread.samples.stack[sampleIndex];
        let nodeId: number;

        if (stackIndex === null) {
            nodeId = 1;
        } else if (!Number.isInteger(stackIndex) || stackIndex < 0 || stackIndex >= stackLength) {
            throw new Error('Gecko profile sample has an invalid stack index');
        } else {
            nodeId = stackIndex + 2;
        }

        const weight = weights?.[sampleIndex] ?? 1;
        const totalDelta = micros(rawTimeDeltas[sampleIndex]);
        const baseDelta = Math.floor(totalDelta / weight);
        const remainder = totalDelta % weight;

        // Fxprof can collapse adjacent identical observations into one weighted
        // sample. Their individual timestamps are gone, so distribute the elapsed
        // time evenly while preserving both observation count and total duration.
        for (let i = 0; i < weight; i++) {
            samples[expandedIndex] = nodeId;
            timeDeltas[expandedIndex] = baseDelta + (i < remainder ? 1 : 0);
            expandedIndex++;
        }
    }

    const interval = typeof profile.meta.interval === 'number'
        ? micros(profile.meta.interval)
        : undefined;
    const sampledEnd = timeDeltas.reduce((sum, delta) => sum + delta, 0);
    const declaredEnd = [thread.unregisterTime, thread.processShutdownTime]
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
        .reduce((end, value) => Math.max(end, micros(value)), 0);

    return {
        _name: thread.name || thread.processName || null,
        _runtime: detectGeckoRuntime(profile, thread),
        _samplesInterval: interval,
        startTime: 0,
        endTime: Math.max(declaredEnd, sampledEnd + (interval || 0)),
        nodes,
        samples,
        timeDeltas
    };
}

export function extractFromGeckoProfile(profile: GeckoProfile): V8CpuProfileSet {
    return {
        indexToView: 0,
        profiles: [convertThread(profile, selectedThread(profile))]
    };
}
