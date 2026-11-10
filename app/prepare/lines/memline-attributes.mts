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

export function createMemlineAllocationOwnerAttribute(
    compilations: CpuProCompilationRecord[] | null,
    _cpuproAllocationIds: AllocationIdVector | null,
    _cpuproAllocationIdsOrder: V8CpuProfileCpuproExtensions['_cpuproAllocationIdsOrder'] | null = null
): ProfileLineAllocationOwnerAttribute | null {
    if (!compilations?.length || !_cpuproAllocationIds) {
        return null;
    }

    const values = new Uint32Array(_cpuproAllocationIds.length);
    const firstId = _cpuproAllocationIdsOrder === 'consecutive' ? _cpuproAllocationIds[0] : undefined;
    const dict: (CompilationOwner | null)[] = [null];
    const ownerByScript = new Map<number | null, Map<number | null, number>>();

    for (const record of compilations) {
        const { scriptId, start } = record;
        let byStart = ownerByScript.get(scriptId);

        if (byStart === undefined) {
            ownerByScript.set(scriptId, byStart = new Map());
        }

        let ownerIndex = byStart.get(start);

        if (ownerIndex === undefined) {
            byStart.set(start, ownerIndex = dict.push({ scriptId, start }) - 1);
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

    for (const { name } of compilations) {
        if (!stageByName.has(name)) {
            stageByName.set(name, dict.push(name) - 1);
        }
    }

    const values = createDictIndexVector(_cpuproAllocationIds.length, dict.length);
    const firstId = _cpuproAllocationIdsOrder === 'consecutive' ? _cpuproAllocationIds[0] : undefined;

    for (const record of compilations) {
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
    { allocationStart, allocationEnd }: CpuProCompilationRecord,
    value: number
) {
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

    const map = new Map<number, number>();
    const allocationTypeNames = Object.entries(_cpuproAllocationTypeNames || {})
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([id, name]) => {
            map.set(Number(id), map.size);
            return name.replace(/_TYPE$/, '');
        });

    const values = createDictIndexVector(_cpuproAllocationTypes.length, allocationTypeNames.length);
    let prevType = -1;
    let prevTypeIndex = 0;

    // Consecutive allocations often share a type, so the map is consulted only on value changes
    for (let i = 0; i < _cpuproAllocationTypes.length; i++) {
        if (_cpuproAllocationTypes[i] !== prevType) {
            prevType = _cpuproAllocationTypes[i];
            prevTypeIndex = map.get(prevType) || 0;
        }

        values[i] = prevTypeIndex;
    }

    return {
        name: 'allocationType',
        values,
        dict: allocationTypeNames
    };
}

export function createMemlineGcEpochAttribute(
    _cpuproAllocationGc: AllocationGcVector | null
): ProfileLineAllocationGcEpochAttribute | null {
    if (!_cpuproAllocationGc) {
        return null;
    }

    const allocationGcEpochs = _cpuproAllocationGc;
    const allocationGcEpochDict: GcEpochDictEntry[] = [];
    const epochToIndex = new Map<number, number>();
    const epochs = new Set<number>();
    let prevEpochId = -1;
    let prevEpoch = -1;

    // Allocations dying in the same GC form long runs, so Set/Map are consulted
    // only on value changes rather than for every allocation
    for (let i = 0; i < allocationGcEpochs.length; i++) {
        if (allocationGcEpochs[i] !== prevEpoch) {
            prevEpoch = allocationGcEpochs[i];
            epochs.add(prevEpoch);
        }
    }

    const sortedEpochs = [...epochs].sort((a, b) => a - b);

    for (const epoch of sortedEpochs) {
        const currentEpochId = epoch >>> 2;

        // Fill in any missing epochs with "unknown" entries
        while (prevEpochId !== -1 && ++prevEpochId < currentEpochId) {
            allocationGcEpochDict.push({
                type: 'unknown',
                epoch: prevEpochId,
                color: typeColor.unknown
            });
        }

        epochToIndex.set(epoch, allocationGcEpochDict.length);
        allocationGcEpochDict.push({
            type: epoch === 0 ? 'none' : epoch & 1 ? 'minor' : 'major',
            epoch: currentEpochId,
            color: typeColor[epoch === 0 ? 'alive' : epoch & 1 ? 'short-lived' : 'long-lived']
        });

        prevEpochId = currentEpochId || prevEpochId;
    }

    const values = createDictIndexVector(allocationGcEpochs.length, allocationGcEpochDict.length);
    let prevEpochIndex = 0;
    prevEpoch = -1;

    for (let i = 0; i < allocationGcEpochs.length; i++) {
        if (allocationGcEpochs[i] !== prevEpoch) {
            prevEpoch = allocationGcEpochs[i];
            prevEpochIndex = epochToIndex.get(prevEpoch)!;
        }

        values[i] = prevEpochIndex;
    }

    return {
        name: 'allocationGcEpoch',
        values,
        dict: allocationGcEpochDict
    };
}

export function createMemlineAllocationLifespanAttribute(
    _cpuproAllocationGc: AllocationGcVector | null
): ProfileLineAllocationLifespanAttribute | null {
    if (!_cpuproAllocationGc) {
        return null;
    }

    const allocationLifespans = new Uint8Array(_cpuproAllocationGc);
    const allocationLifespanDict: AllocationLifespan[] = ['alive', 'short-lived', 'long-lived'];

    for (let i = 0; i < allocationLifespans.length; i++) {
        allocationLifespans[i] = allocationLifespans[i] & 3;
    }

    return {
        name: 'allocationLifespan',
        values: allocationLifespans,
        dict: allocationLifespanDict
    };
}

export function createMemlineAllocationSpaceAttribute(
    _cpuproAllocationSpaces: AllocationSpaceVector | null,
    _cpuproAllocationSpaceNames: Record<number, string> | null
): ProfileLineAllocationSpaceAttribute | null {
    if (!_cpuproAllocationSpaces) {
        return null;
    }

    const map = new Map<number, number>();
    const allocationSpaceNames: AllocationSpaceDictEntry[] = Object.entries(_cpuproAllocationSpaceNames || {})
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([id, name]) => {
            map.set(Number(id), map.size);
            return {
                code: name,
                color: typeColor[name.replace(/large_object_/, 'lo_')],
                name: name
                    .replace(/_space$/, '')
                    .replace(/_/g, ' ')
                    .replace(/^(?=large object)/, 'old ')
                    .replace(/^./, str => str.toUpperCase())
            };
        });

    const values = createDictIndexVector(_cpuproAllocationSpaces.length, allocationSpaceNames.length);
    let prevSpace = -1;
    let prevSpaceIndex = 0;

    // Consecutive allocations mostly share a space, so the map is consulted only on value changes
    for (let i = 0; i < _cpuproAllocationSpaces.length; i++) {
        if (_cpuproAllocationSpaces[i] !== prevSpace) {
            prevSpace = _cpuproAllocationSpaces[i];
            prevSpaceIndex = map.get(prevSpace) || 0;
        }

        values[i] = prevSpaceIndex;
    }

    return {
        name: 'allocationSpace',
        values,
        dict: allocationSpaceNames
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

    const allocationCodeTypes = new Uint8Array(_cpuproAllocationCodeType);
    const allocationCodeTypeNames = Object.values(_cpuproAllocationCodeTypeNames || {})
        .map(name => normCodeTypeNames[name] || name);

    if (_cpuproAllocationContextInfo) {
        const buildinType = allocationCodeTypeNames.push('Builtin') - 1;
        const otherType = allocationCodeTypeNames.push('Other') - 1;

        for (let i = 0; i < allocationCodeTypes.length; i++) {
            if (_cpuproAllocationContextInfo[i] !== 0) {
                allocationCodeTypes[i] = _cpuproAllocationContextInfo[i] & 0x0f ? otherType : buildinType;
            }
        }
    }

    return {
        name: 'allocationCodeType',
        values: allocationCodeTypes,
        dict: allocationCodeTypeNames
    };
}
