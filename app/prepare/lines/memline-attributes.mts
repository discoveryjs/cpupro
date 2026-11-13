import { allocTimespan, typeColor } from '../const.js';
import { lowerBound } from '../computations/misc.js';
import { asUint32Array } from '../misc/utils.js';
import { allocationCodeTypes, allocationDictIndices } from './memline-attributes.compute.js';
import type {
    AllocationSpaceDictEntry,
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
    AllocationIdsByGc,
    AllocationIdVector,
    AllocationSpaceVector,
    AllocationTypeVector,
    CpuProCompilationRecord,
    CpuProCompilationSubject,
    V8CpuProfileCpuproExtensions
} from '../types.js';

// Values of an attribute are indices of its dictionary; a vector of an allocation-sized length takes a quarter
// of the memory with 1-byte indices, which are enough for most dictionaries
function createDictIndexVector(length: number, dictLength: number): Uint8Array | Uint32Array {
    return dictLength <= 256
        ? new Uint8Array(length)
        : new Uint32Array(length);
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
    const values = allocationDictIndices(
        asUint32Array(_cpuproAllocationTypes),
        namedCodesTable(codes),
        createDictIndexVector(_cpuproAllocationTypes.length, dict.length)
    );

    return {
        name: 'allocationType',
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
    const values = allocationDictIndices(
        asUint32Array(_cpuproAllocationSpaces),
        namedCodesTable(codes),
        createDictIndexVector(_cpuproAllocationSpaces.length, dict.length)
    );

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

export function createMemlineAllocationLifespanAttribute(
    _cpuproAllocationGc: AllocationGcVector | null
): ProfileLineAllocationLifespanAttribute | null {
    if (!_cpuproAllocationGc) {
        return null;
    }

    // Lifespans are the low bits of GC values, which a byte keeps
    const values = new Uint8Array(_cpuproAllocationGc);

    for (let i = 0; i < values.length; i++) {
        values[i] &= 3;
    }

    return lifespanAttribute(values);
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

    const epochs = presentTableEpochs(present, offset);
    const entries = addGcEpochEntries(dict, epochs);

    for (let i = 0; i < epochs.length; i++) {
        epochIndices[epochs[i] - offset] = entries[i];
    }

    const values = createDictIndexVector(gc.length, dict.length);

    for (let i = 0; i < gc.length; i++) {
        values[i] = epochIndices[Math.max(gc[i] - offset, 0)];
    }

    return gcEpochAttribute(values, dict);
}

// GC values present in a table of values from the one after the offset, in ascending order
function presentTableEpochs(present: Uint8Array, offset: number) {
    const epochs: number[] = [];

    for (let i = 1; i < present.length; i++) {
        if (present[i] === 1) {
            epochs.push(offset + i);
        }
    }

    return epochs;
}

// Lifespan and GC epoch attributes of allocations from their GC, which comes either as lists of allocation IDs
// by GC value or as a GC value per allocation
export function createMemlineGcAttributes(
    _cpuproAllocationGc: AllocationGcVector | null,
    _cpuproAllocationGcIds: AllocationIdsByGc[] | null,
    _cpuproAllocationIds: AllocationIdVector | null,
    _cpuproAllocationIdsOrder: V8CpuProfileCpuproExtensions['_cpuproAllocationIdsOrder'] | null
) {
    if (_cpuproAllocationGcIds !== null && _cpuproAllocationIds !== null) {
        return gcAttributesFromIds(_cpuproAllocationGcIds, _cpuproAllocationIds, _cpuproAllocationIdsOrder);
    }

    return [
        createMemlineAllocationLifespanAttribute(_cpuproAllocationGc),
        createMemlineGcEpochAttribute(_cpuproAllocationGc)
    ];
}

// Lifespan and GC epoch attributes from the marking of allocations by collections, as traces give it: lists
// of allocation IDs by GC value, a list per collection, each ID in one list only; allocations of no list are alive.
// The values are known from the lists, so the dictionary comes before the attributes, and a single pass over
// the lists writes both attributes
function gcAttributesFromIds(
    gcIds: AllocationIdsByGc[],
    ids: AllocationIdVector,
    idsOrder: V8CpuProfileCpuproExtensions['_cpuproAllocationIdsOrder'] | null
): [ProfileLineAllocationLifespanAttribute, ProfileLineAllocationGcEpochAttribute] {
    const dict: GcEpochDictEntry[] = [];
    const epochs = listedEpochs(gcIds);
    let listedIds = 0;

    for (let i = 0; i < gcIds.length; i++) {
        const keys = Object.keys(gcIds[i]);

        for (let j = 0; j < keys.length; j++) {
            listedIds += gcIds[i][keys[j]].length;
        }
    }

    if (listedIds < ids.length) {
        dict.push(gcEpochEntry(0));
    }

    const entries = addGcEpochEntries(dict, epochs);
    const lifespans = new Uint8Array(ids.length);
    const values = createDictIndexVector(ids.length, dict.length);
    const firstId = consecutiveFirstId(ids, idsOrder);

    for (let i = 0; i < gcIds.length; i++) {
        const keys = Object.keys(gcIds[i]);

        for (let j = 0; j < keys.length; j++) {
            const gc = parseInt(keys[j]);
            const entry = entries[lowerBound(epochs, gc)];

            fillAllocationGc(lifespans, values, ids, firstId, gcIds[i][keys[j]], gc & 3, entry);
        }
    }

    return [
        lifespanAttribute(lifespans),
        gcEpochAttribute(values, dict)
    ];
}

// GC values of lists of allocation IDs in ascending order; a list of a collection may be split between chunks
function listedEpochs(gcIds: AllocationIdsByGc[]) {
    const gcValues = new Set<number>();

    for (let i = 0; i < gcIds.length; i++) {
        const keys = Object.keys(gcIds[i]);

        for (let j = 0; j < keys.length; j++) {
            gcValues.add(parseInt(keys[j]));
        }
    }

    return [...gcValues].sort((a, b) => a - b);
}

// Allocations of the IDs of a list take the lifespan and the epoch entry of its GC value; when IDs are consecutive,
// an ID gives its allocation without a search
function fillAllocationGc(
    lifespans: Uint8Array,
    values: Uint8Array | Uint32Array,
    ids: AllocationIdVector,
    firstId: number | undefined,
    listIds: Uint32Array,
    lifespan: number,
    entry: number
) {
    if (firstId !== undefined) {
        for (let i = 0; i < listIds.length; i++) {
            const index = listIds[i] - firstId;

            lifespans[index] = lifespan;
            values[index] = entry;
        }
    } else {
        for (let i = 0; i < listIds.length; i++) {
            const index = lowerBound(ids, listIds[i]);

            lifespans[index] = lifespan;
            values[index] = entry;
        }
    }
}

function lifespanAttribute(values: Uint8Array): ProfileLineAllocationLifespanAttribute {
    return {
        name: 'allocationLifespan',
        values,
        dict: [...allocTimespan]
    };
}

function gcEpochAttribute(
    values: Uint8Array | Uint32Array,
    dict: GcEpochDictEntry[]
): ProfileLineAllocationGcEpochAttribute {
    return {
        name: 'allocationGcEpoch',
        values,
        dict
    };
}

// Entries of GC values in ascending order added to the dictionary, and their indices; collections without allocations
// of their own between the values take "unknown" entries
function addGcEpochEntries(dict: GcEpochDictEntry[], epochs: number[]) {
    const entries = new Uint32Array(epochs.length);
    let prevEpochId = -1;

    for (let i = 0; i < epochs.length; i++) {
        const epochId = epochs[i] >>> 2;

        if (prevEpochId !== -1) {
            for (let j = prevEpochId + 1; j < epochId; j++) {
                dict.push({
                    type: 'unknown',
                    epoch: j,
                    color: typeColor.unknown
                });
            }
        }

        entries[i] = dict.length;
        dict.push(gcEpochEntry(epochs[i]));
        prevEpochId = epochId;
    }

    return entries;
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
    const dict = Object.values(_cpuproAllocationCodeTypeNames || {})
        .map(name => normCodeTypeNames[name] || name);
    // Code types are indices of their names, which a byte keeps
    let values: Uint8Array;

    // Allocations of builtins and of VM states other than JS take their own code types, a VM state taking precedence
    // over a builtin it runs under (see contextInfoKind)
    if (contextInfo) {
        const builtinType = dict.push('Builtin') - 1;
        const otherType = dict.push('Other') - 1;

        values = allocationCodeTypes(
            asUint32Array(_cpuproAllocationCodeType),
            asUint32Array(contextInfo),
            builtinType,
            otherType
        );
    } else {
        values = new Uint8Array(_cpuproAllocationCodeType);
    }

    return {
        name: 'allocationCodeType',
        values,
        dict
    };
}

// Owners and compilation stages of allocations: an allocation takes the compilation subject and the stage of the record
// it is allocated within. Records come by their allocation ranges, an enclosing one before those it encloses
// (see compareCompilationRecords), so ranges of nested records overwrite the enclosing one and an allocation takes
// the innermost record. A single pass over the records writes both attributes
export function createMemlineCompilationAttributes(
    compilations: CpuProCompilationRecord[] | null,
    _cpuproAllocationIds: AllocationIdVector | null,
    _cpuproAllocationIdsOrder: V8CpuProfileCpuproExtensions['_cpuproAllocationIdsOrder'] | null = null
): [ProfileLineAllocationOwnerAttribute, ProfileLineAllocationCompilationStageAttribute] | [] {
    if (!compilations?.length || !_cpuproAllocationIds) {
        return [];
    }

    // Subjects and stages of indices follow the absent owner and stage; every subject and stage has records,
    // so the dictionaries are dense
    const ownerDict: (CpuProCompilationSubject | null)[] = [null];
    const stageDict = ['none'];

    for (let i = 0; i < compilations.length; i++) {
        const record = compilations[i];

        ownerDict[record.subject!.index + 1] = record.subject!;
        stageDict[record.stage + 1] = record.name;
    }

    const ids = _cpuproAllocationIds;
    const firstId = consecutiveFirstId(ids, _cpuproAllocationIdsOrder);
    const owners = new Uint32Array(ids.length);
    const stages = createDictIndexVector(ids.length, stageDict.length);

    // Allocations from the start to the end of a record; when IDs are consecutive, the range of IDs gives the range
    // of allocations without a search
    for (let i = 0; i < compilations.length; i++) {
        const record = compilations[i];

        if (record.allocationStart === null ||
            record.allocationEnd === null ||
            record.allocationEnd <= record.allocationStart
        ) {
            continue;
        }

        const start = firstId !== undefined
            ? Math.min(Math.max(record.allocationStart - firstId + 1, 0), ids.length)
            : lowerBound(ids, record.allocationStart, true);
        const end = firstId !== undefined
            ? Math.min(Math.max(record.allocationEnd - firstId + 1, 0), ids.length)
            : lowerBound(ids, record.allocationEnd, true);

        owners.fill(record.subject!.index + 1, start, end);
        stages.fill(record.stage + 1, start, end);
    }

    return [
        {
            name: 'allocationOwner',
            values: owners,
            dict: ownerDict
        },
        {
            name: 'allocationCompilationStage',
            values: stages,
            dict: stageDict
        }
    ];
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
