import { AllocationLifespan, typeColor } from '../const.js';
import {
    AllocationSpaceDictEntry,
    GcEpochDictEntry,
    ProfileLineAllocationCodeTypeAttribute,
    ProfileLineAllocationGcEpochAttribute,
    ProfileLineAllocationLifespanAttribute,
    ProfileLineAllocationSpaceAttribute,
    ProfileLineAllocationTypeAttribute
} from './types.js';

export function createMemlineAllocationTypeAttribute(
    _cpuproAllocationTypes: number[] | Uint32Array | null,
    _cpuproAllocationTypeNames: Record<number, string> | null
): ProfileLineAllocationTypeAttribute | null {
    if (!_cpuproAllocationTypes) {
        return null;
    }

    const map = new Map<number, number>();

    const allocationTypeVector = new Uint32Array(_cpuproAllocationTypes);
    const allocationTypeNames = Object.entries(_cpuproAllocationTypeNames || {})
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([id, name]) => {
            map.set(Number(id), map.size);
            return name.replace(/_TYPE$/, '');
        });

    for (let i = 0; i < allocationTypeVector.length; i++) {
        allocationTypeVector[i] = map.get(allocationTypeVector[i]) || 0;
    }

    return {
        name: 'allocationType',
        values: allocationTypeVector,
        dict: allocationTypeNames
    };
}

export function createMemlineGcEpochAttribute(
    _cpuproAllocationGc: number[] | Uint32Array | null
): ProfileLineAllocationGcEpochAttribute | null {
    if (!_cpuproAllocationGc) {
        return null;
    }

    const epochs = new Set<number>(_cpuproAllocationGc);
    const sortedEpochs = [...epochs].sort((a, b) => a - b);
    const epochToIndex = new Map<number, number>();

    const allocationGcEpochs = new Uint32Array(_cpuproAllocationGc);;
    const allocationGcEpochDict: GcEpochDictEntry[] = [];
    let prevEpochId = -1;

    for (const epoch of sortedEpochs) {
        const currentEpochId = epoch >> 2;

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
            epoch: epoch >> 2,
            color: typeColor[epoch === 0 ? 'alive' : epoch & 1 ? 'short-lived' : 'long-lived']
        });

        prevEpochId = currentEpochId || prevEpochId;
    }
    console.log(allocationGcEpochDict);

    for (let i = 0; i < allocationGcEpochs.length; i++) {
        allocationGcEpochs[i] = epochToIndex.get(allocationGcEpochs[i])!;
    }

    return {
        name: 'allocationGcEpoch',
        values: allocationGcEpochs,
        dict: allocationGcEpochDict
    };
}

export function createMemlineAllocationLifespanAttribute(
    _cpuproAllocationGc: number[] | Uint32Array | null
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
    _cpuproAllocationSpaces: number[] | Uint32Array | null,
    _cpuproAllocationSpaceNames: Record<number, string> | null
): ProfileLineAllocationSpaceAttribute | null {
    if (!_cpuproAllocationSpaces) {
        return null;
    }

    const map = new Map<number, number>();
    const allocationSpaces = new Uint32Array(_cpuproAllocationSpaces);
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

    for (let i = 0; i < allocationSpaces.length; i++) {
        allocationSpaces[i] = map.get(allocationSpaces[i]) || 0;
    }

    return {
        name: 'allocationSpace',
        values: allocationSpaces || new Uint32Array(0),
        dict: allocationSpaceNames || []
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
    _cpuproAllocationCodeType: number[] | Uint32Array | null,
    _cpuproAllocationCodeTypeNames: Record<number, string> | null,
    _cpuproAllocationContextInfo: number[] | Uint32Array | null
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
