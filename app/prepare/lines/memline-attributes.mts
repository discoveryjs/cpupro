import { AllocationLifespan, typeColor } from '../const.js';
import { lowerBound } from '../computations/misc.js';
import type {
    AllocationSpaceDictEntry,
    CompilationOwner,
    GcEpochDictEntry,
    ProfileLineAllocationCodeTypeAttribute,
    ProfileLineAllocationGcEpochAttribute,
    ProfileLineAllocationLifespanAttribute,
    ProfileLineAllocationSpaceAttribute,
    ProfileLineAllocationTypeAttribute,
    ProfileLineAllocationOwnerAttribute,
    ProfileLineAllocationCompilationStageAttribute
} from './types.js';
import type {
    AllocationCodeTypeVector,
    AllocationContextInfoVector,
    AllocationGcVector,
    AllocationIdVector,
    AllocationSpaceVector,
    AllocationTypeVector,
    CpuProCompilationRecord,
    V8CpuProfileCpuproExtensions
} from '../types.js';

// Values of an attribute are indices of its dictionary; a vector of an allocation-sized length takes a quarter
// of the memory with 1-byte indices, which are enough for most dictionaries
function createDictIndexVector(length: number, dictLength: number): Uint8Array | Uint32Array {
    return dictLength <= 256
        ? new Uint8Array(length)
        : new Uint32Array(length);
}

// Dictionary indices of codes through a table indexed by the codes. Codes repeat a few values with frequent changes,
// so a table read per event costs less than a map lookup per change of the value
function dictIndices(codes: ArrayLike<number>, table: Uint32Array, dictLength: number) {
    const values = createDictIndexVector(codes.length, dictLength);

    // PERF: A code beyond the table reads undefined, which a typed array stores as index 0, instead of a clamp per code
    for (let i = 0; i < codes.length; i++) {
        values[i] = table[codes[i]];
    }

    return values;
}

// Codes of a dictionary of names in ascending order
function namedCodes(names: Record<number, string>) {
    return Object.keys(names)
        .map(Number)
        .sort((a, b) => a - b);
}

// Table of the indices of codes in ascending order
function namedCodesTable(codes: number[]) {
    const tableLength = codes.length > 0
        ? codes[codes.length - 1] + 1
        : 0;
    const table = new Uint32Array(tableLength);

    for (let i = 0; i < codes.length; i++) {
        table[codes[i]] = i;
    }

    return table;
}

// The first allocation ID when IDs are consecutive, so a range of IDs is a range of allocations
function consecutiveFirstId(
    ids: AllocationIdVector,
    order: V8CpuProfileCpuproExtensions['_cpuproAllocationIdsOrder'] | null
) {
    return order === 'consecutive'
        ? ids[0]
        : undefined;
}

export function createMemlineAllocationOwnerAttribute(
    compilations: CpuProCompilationRecord[] | null,
    _cpuproAllocationIds: AllocationIdVector | null,
    _cpuproAllocationIdsOrder: V8CpuProfileCpuproExtensions['_cpuproAllocationIdsOrder'] | null = null
): ProfileLineAllocationOwnerAttribute | null {
    if (!compilations?.length || !_cpuproAllocationIds) {
        return null;
    }

    const values = new Uint32Array(_cpuproAllocationIds.length);
    const firstId = consecutiveFirstId(_cpuproAllocationIds, _cpuproAllocationIdsOrder);
    const dict: (CompilationOwner | null)[] = [null];
    const ownerByScript = new Map<number | null, Map<number | null, number>>();

    for (let i = 0; i < compilations.length; i++) {
        const record = compilations[i];
        let byStart = ownerByScript.get(record.scriptId);

        if (byStart === undefined) {
            byStart = new Map();
            ownerByScript.set(record.scriptId, byStart);
        }

        let ownerIndex = byStart.get(record.start);

        if (ownerIndex === undefined) {
            ownerIndex = dict.push({
                scriptId: record.scriptId,
                start: record.start
            }) - 1;
            byStart.set(record.start, ownerIndex);
        }

        fillCompilationAllocationRange(values, _cpuproAllocationIds, firstId, record, ownerIndex);
    }

    return {
        name: 'allocationOwner',
        values,
        dict
    };
}

export function createMemlineAllocationCompilationStageAttribute(
    compilations: CpuProCompilationRecord[] | null,
    _cpuproAllocationIds: AllocationIdVector | null,
    _cpuproAllocationIdsOrder: V8CpuProfileCpuproExtensions['_cpuproAllocationIdsOrder'] | null = null
): ProfileLineAllocationCompilationStageAttribute | null {
    if (!compilations?.length || !_cpuproAllocationIds) {
        return null;
    }

    const dict = ['none'];
    const stageByName = new Map<string, number>();

    for (let i = 0; i < compilations.length; i++) {
        const { name } = compilations[i];

        if (!stageByName.has(name)) {
            stageByName.set(name, dict.push(name) - 1);
        }
    }

    const values = createDictIndexVector(_cpuproAllocationIds.length, dict.length);
    const firstId = consecutiveFirstId(_cpuproAllocationIds, _cpuproAllocationIdsOrder);

    for (let i = 0; i < compilations.length; i++) {
        const record = compilations[i];

        fillCompilationAllocationRange(values, _cpuproAllocationIds, firstId, record, stageByName.get(record.name)!);
    }

    return {
        name: 'allocationCompilationStage',
        values,
        dict
    };
}

function fillCompilationAllocationRange(
    values: Uint8Array | Uint32Array,
    ids: AllocationIdVector,
    firstId: number | undefined,
    record: CpuProCompilationRecord,
    value: number
) {
    const { allocationStart, allocationEnd } = record;

    if (allocationStart === null || allocationEnd === null || allocationEnd <= allocationStart) {
        return;
    }

    const start = firstId !== undefined
        ? Math.max(0, Math.min(ids.length, allocationStart - firstId + 1))
        : lowerBound(ids, allocationStart, true);
    const end = firstId !== undefined
        ? Math.max(0, Math.min(ids.length, allocationEnd - firstId + 1))
        : lowerBound(ids, allocationEnd, true);

    values.fill(value, start, end);
}

export function createMemlineAllocationTypeAttribute(
    _cpuproAllocationTypes: AllocationTypeVector | null,
    _cpuproAllocationTypeNames: Record<number, string> | null
): ProfileLineAllocationTypeAttribute | null {
    if (!_cpuproAllocationTypes) {
        return null;
    }

    const names = _cpuproAllocationTypeNames || {};
    const codes = namedCodes(names);
    const dict = codes.map(code => names[code].replace(/_TYPE$/, ''));
    const values = dictIndices(_cpuproAllocationTypes, namedCodesTable(codes), dict.length);

    return {
        name: 'allocationType',
        values,
        dict
    };
}

// A GC value is the number of the collection a dead allocation died in, then the lifespan bits; 0 is an allocation
// alive at the end of the recording. Collection numbers of a recording are a narrow range wherever it starts in
// a process, so the table takes their range after an entry for 0
export function createMemlineGcEpochAttribute(
    _cpuproAllocationGc: AllocationGcVector | null
): ProfileLineAllocationGcEpochAttribute | null {
    if (!_cpuproAllocationGc) {
        return null;
    }

    const gc = _cpuproAllocationGc;
    const dict: GcEpochDictEntry[] = [];
    // Entry 0 is for 0, entries from 1 are for collections from the smallest one, so the offset is the value before it
    let offset = 0xffffffff;
    let maxEpoch = 0;
    let prevEpochId = -1;

    // PERF: Math.min and Math.max take the range faster than comparisons, in V8 of both Node and Chrome.
    // 0 - 1 wraps to the largest value, so allocations of no collection don't lower the offset, without a branch
    for (let i = 0; i < gc.length; i++) {
        offset = Math.min(offset, (gc[i] - 1) >>> 0);
        maxEpoch = Math.max(maxEpoch, gc[i]);
    }

    const tableLength = maxEpoch > offset
        ? maxEpoch - offset + 1
        : 1;
    const epochIndices = new Uint32Array(tableLength);
    const present = new Uint8Array(tableLength);

    // 0 is at or below the offset and takes entry 0, no value is beyond the largest one
    for (let i = 0; i < gc.length; i++) {
        present[Math.max(gc[i] - offset, 0)] = 1;
    }

    if (present[0] === 1) {
        dict.push(gcEpochEntry(0));
    }

    for (let i = 1; i < present.length; i++) {
        if (present[i] === 0) {
            continue;
        }

        const epoch = offset + i;
        const epochId = epoch >>> 2;

        // Collections without allocations of their own take "unknown" entries
        if (prevEpochId !== -1) {
            for (let j = prevEpochId + 1; j < epochId; j++) {
                dict.push({
                    type: 'unknown',
                    epoch: j,
                    color: typeColor.unknown
                });
            }
        }

        epochIndices[i] = dict.length;
        dict.push(gcEpochEntry(epoch));
        prevEpochId = epochId;
    }

    const values = createDictIndexVector(gc.length, dict.length);

    for (let i = 0; i < gc.length; i++) {
        values[i] = epochIndices[Math.max(gc[i] - offset, 0)];
    }

    return {
        name: 'allocationGcEpoch',
        values,
        dict
    };
}

// The lifespan bits of a GC value: 0 is no collection, 1 a minor one, 2 a major one
function gcEpochEntry(epoch: number): GcEpochDictEntry {
    const epochId = epoch >>> 2;

    if (epoch === 0) {
        return {
            type: 'none',
            epoch: epochId,
            color: typeColor.alive
        };
    }

    return epoch & 1
        ? {
            type: 'minor',
            epoch: epochId,
            color: typeColor['short-lived']
        }
        : {
            type: 'major',
            epoch: epochId,
            color: typeColor['long-lived']
        };
}

export function createMemlineAllocationLifespanAttribute(
    _cpuproAllocationGc: AllocationGcVector | null
): ProfileLineAllocationLifespanAttribute | null {
    if (!_cpuproAllocationGc) {
        return null;
    }

    // Lifespans are the low bits of GC values, which a byte keeps
    const values = new Uint8Array(_cpuproAllocationGc);
    const dict: AllocationLifespan[] = ['alive', 'short-lived', 'long-lived'];

    for (let i = 0; i < values.length; i++) {
        values[i] &= 3;
    }

    return {
        name: 'allocationLifespan',
        values,
        dict
    };
}

export function createMemlineAllocationSpaceAttribute(
    _cpuproAllocationSpaces: AllocationSpaceVector | null,
    _cpuproAllocationSpaceNames: Record<number, string> | null
): ProfileLineAllocationSpaceAttribute | null {
    if (!_cpuproAllocationSpaces) {
        return null;
    }

    const names = _cpuproAllocationSpaceNames || {};
    const codes = namedCodes(names);
    const dict: AllocationSpaceDictEntry[] = codes.map(code => spaceDictEntry(names[code]));
    const values = dictIndices(_cpuproAllocationSpaces, namedCodesTable(codes), dict.length);

    return {
        name: 'allocationSpace',
        values,
        dict
    };
}

function spaceDictEntry(code: string): AllocationSpaceDictEntry {
    return {
        code,
        color: typeColor[code.replace(/large_object_/, 'lo_')],
        name: code
            .replace(/_space$/, '')
            .replace(/_/g, ' ')
            .replace(/^(?=large object)/, 'old ')
            .replace(/^./, str => str.toUpperCase())
    };
}

const normCodeTypeNames = {
    'unknown': 'Unknown',
    'ignition': 'Ignition',
    'baseline': 'Sparkplug',
    'maglev': 'Maglev',
    'turbofan': 'Turbofan'
};

export function createMemlineAllocationCodeTypeAttribute(
    _cpuproAllocationCodeType: AllocationCodeTypeVector | null,
    _cpuproAllocationCodeTypeNames: Record<number, string> | null,
    _cpuproAllocationContextInfo: AllocationContextInfoVector | null
): ProfileLineAllocationCodeTypeAttribute | null {
    if (!_cpuproAllocationCodeType) {
        return null;
    }

    const contextInfo = _cpuproAllocationContextInfo;
    // Code types are indices of their names, which a byte keeps
    const values = new Uint8Array(_cpuproAllocationCodeType);
    const dict = Object.values(_cpuproAllocationCodeTypeNames || {})
        .map(name => normCodeTypeNames[name] || name);

    // Allocations of builtins and other non-JS contexts take their own code types
    if (contextInfo) {
        const builtinType = dict.push('Builtin') - 1;
        const otherType = dict.push('Other') - 1;

        for (let i = 0; i < values.length; i++) {
            if (contextInfo[i] !== 0) {
                values[i] = contextInfo[i] & 0x0f
                    ? otherType
                    : builtinType;
            }
        }
    }

    return {
        name: 'allocationCodeType',
        values,
        dict
    };
}
