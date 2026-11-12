import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createDiagnosticsCollector, type Diagnose } from '../diagnostics.js';
import { extractAndValidate } from '../index.js';

const rootCallFrame = {
    functionName: '(root)',
    scriptId: 0,
    url: '',
    lineNumber: -1,
    columnNumber: -1
};
const fnCallFrame = {
    functionName: 'fn',
    scriptId: 1,
    url: 'a.js',
    lineNumber: 0,
    columnNumber: 0
};

// A profile of two samples of one node, with fields of a test on top
function cpuProfile(fields: object = {}) {
    return {
        startTime: 0,
        endTime: 20,
        nodes: [
            {
                id: 1,
                callFrame: rootCallFrame,
                children: [2]
            },
            {
                id: 2,
                callFrame: fnCallFrame
            }
        ],
        samples: [2, 2],
        timeDeltas: [10, 10],
        ...fields
    };
}

// The profile extracted from an input, which extraction never changes nor returns as is
function extractProfile(input: object, diagnose?: Diagnose) {
    const before = structuredClone(input);
    const profile = extractAndValidate(input, () => {}, diagnose).sessions[0].profiles[0];

    assert.deepEqual(input, before);
    assert.notEqual(profile, input);

    return profile;
}

function allocationKeys(profile: object) {
    return Object.keys(profile).filter(key => key.startsWith('_cpuproAllocation'));
}

test('adopts typed numeric vectors without copies', () => {
    const input = cpuProfile({
        samples: new Uint32Array([2, 2]),
        timeDeltas: new Uint32Array([10, 10]),
        allocationSampleIds: new Uint32Array([10, 12]),
        allocationSamples: {
            ids: new Uint32Array([10, 12]),
            sizes: new Uint32Array([8, 16]),
            gc: new Uint32Array([0, 5]),
            types: new Uint32Array([1, 1]),
            scriptIds: new Uint32Array([7, 7]),
            positions: new Int32Array([9, 12])
        }
    });
    const profile = extractProfile(input);

    assert.equal(profile.samples, input.samples);
    assert.equal(profile.timeDeltas, input.timeDeltas);
    assert.equal(profile._cpuproAllocationIds, input.allocationSamples.ids);
    assert.equal(profile._cpuproAllocationGc, input.allocationSamples.gc);
    assert.equal(profile._cpuproAllocationTypes, input.allocationSamples.types);
    assert.equal(profile._cpuproAllocationScriptIds, input.allocationSamples.scriptIds);
    assert.equal(profile._cpuproAllocationLocations, input.allocationSamples.positions);
});

// A combined profile wraps CPU samples into `cpuProfile`
test.each([
    { allocationSamples: undefined },
    { allocationSamples: {} },
    { allocationSamples: { ids: [10, 15] } },
    { allocationSamples: { sizes: [8, 16] } }
])('keeps the sample mapping of a combined profile without complete allocation rows: %j', row => {
    const input = cpuProfile({
        cpuProfile: {
            samples: [2],
            timeDeltas: [20],
            nodes: cpuProfile().nodes
        },
        allocationSampleIds: [10, 15],
        allocationSamples: row.allocationSamples
    });
    const profile = extractProfile(input);

    assert.equal(profile.samples, input.cpuProfile.samples);
    assert.equal(profile.timeDeltas, input.cpuProfile.timeDeltas);
    assert.equal(profile.nodes, input.cpuProfile.nodes);
    assert.equal(profile._cpuproAllocationMapping, input.allocationSampleIds);
    assert.deepEqual(allocationKeys(profile), ['_cpuproAllocationMapping']);
});

test.each([
    { ids: [10, 11, 12], order: 'consecutive' },
    { ids: [10, 12, 15], order: 'ascending' }
])('publishes sorted allocation rows with their $order order', row => {
    const allocationSamples = {
        ids: row.ids,
        sizes: [8, 16, 32],
        types: [1, 2, 3],
        gc: [0, 1, 2],
        typesDict: { 1: 'OBJECT' }
    };
    const input = cpuProfile({
        allocationSampleIds: [10, 15],
        allocationSamples
    });
    const { diagnostics, diagnose } = createDiagnosticsCollector();
    const profile = extractProfile(input, diagnose);

    assert.equal(profile._cpuproAllocationMapping, input.allocationSampleIds);
    assert.equal(profile._cpuproAllocationIds, row.ids);
    assert.equal(profile._cpuproAllocationIdsOrder, row.order);
    assert.equal(profile._cpuproAllocationSizes, allocationSamples.sizes);
    assert.equal(profile._cpuproAllocationTypes, allocationSamples.types);
    assert.equal(profile._cpuproAllocationGc, allocationSamples.gc);
    assert.deepEqual(diagnostics, []);
});

test('ignores allocation rows with unsorted IDs and reports it', () => {
    const input = cpuProfile({
        allocationSampleIds: [10, 15],
        allocationSamples: {
            ids: [10, 12, 11],
            sizes: [8, 16, 32],
            types: [1, 2, 3],
            gc: [0, 1, 2]
        }
    });
    const { diagnostics, diagnose } = createDiagnosticsCollector();
    const profile = extractProfile(input, diagnose);

    assert.equal(profile._cpuproAllocationMapping, input.allocationSampleIds);
    assert.deepEqual(allocationKeys(profile), ['_cpuproAllocationMapping']);
    assert.deepEqual(diagnostics, [
        {
            level: 'warn',
            scope: ['cpuprofile'],
            message: 'Ignoring allocation data with unsorted IDs'
        }
    ]);
});

test.each([
    {
        name: 'without trace IDs, lines and columns',
        fields: {},
        traceIds: {},
        lines: undefined,
        columns: undefined
    },
    {
        name: 'with trace IDs',
        fields: { trace_ids: { 7: 1 } },
        traceIds: { 7: 1 },
        lines: undefined,
        columns: undefined
    },
    {
        name: 'with trace IDs of an array',
        fields: { trace_ids: [1] },
        traceIds: {},
        lines: undefined,
        columns: undefined
    },
    {
        name: 'with a line and a column per sample',
        fields: { lines: [3, 4], columns: [5, 6] },
        traceIds: {},
        lines: [3, 4],
        columns: [5, 6]
    },
    {
        name: 'with empty lines and columns',
        fields: { lines: [], columns: [] },
        traceIds: {},
        lines: undefined,
        columns: undefined
    },
    {
        name: 'with lines without columns',
        fields: { lines: [3, 4] },
        traceIds: {},
        lines: undefined,
        columns: undefined
    },
    {
        name: 'with fewer columns than lines',
        fields: { lines: [3, 4], columns: [5] },
        traceIds: {},
        lines: undefined,
        columns: undefined
    },
    {
        name: 'with fewer lines and columns than samples',
        fields: { lines: [3], columns: [5] },
        traceIds: {},
        lines: undefined,
        columns: undefined
    },
    {
        name: 'with lines and columns of no vectors',
        fields: { lines: '3,4', columns: { 0: 5, 1: 6 } },
        traceIds: {},
        lines: undefined,
        columns: undefined
    }
])('extracts a profile $name in the common form without changing the input', row => {
    const profile = extractProfile(cpuProfile(row.fields));

    assert.deepEqual(profile.trace_ids, row.traceIds);
    assert.deepEqual(profile.lines, row.lines);
    assert.deepEqual(profile.columns, row.columns);
});

// Samples of sizes are a format of early allocation experiments, no longer current, and samples without time deltas
// have no time: neither is a CPU profile, so both are rejected rather than failing while the profile is created
test.each([
    {
        name: 'of size samples',
        fields: {
            samples: [{ nodeId: 2, size: 32, ordinal: 1 }],
            timeDeltas: undefined
        }
    },
    {
        name: 'of no samples without time deltas',
        fields: {
            samples: [],
            timeDeltas: undefined
        }
    }
])('rejects a profile $name as an unknown format', row => {
    const reasons: string[] = [];
    const rejectData = (reason: string) => {
        reasons.push(reason);
    };

    assert.throws(() => extractAndValidate(cpuProfile(row.fields), rejectData), /Unknown format/);
    assert.deepEqual(reasons, ['Unknown format']);
});
