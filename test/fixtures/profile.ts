import { SourceMapGenerator } from 'source-map-js';
import { Dictionary } from '../../app/prepare/dictionary.js';
import { OriginalScriptsMap, ProfileScriptsMap } from '../../app/prepare/preprocessing/scripts.js';
import { createProfile } from '../../app/prepare/profile.mjs';
import type { V8CpuProfile } from '../../app/prepare/types.js';
import { noopWorkHandler } from '../../app/prepare/misc/work.js';
import { Population, PopulationFiltered } from '../../app/prepare/computations/population.js';
import { RangeSelection, RangeView } from '../../app/prepare/computations/range.js';
import { FilterSet } from '../../app/prepare/computations/filter-set.js';
import { createSampledTreeSet } from '../../app/prepare/computations/sampled-tree-set.js';
import { createLineBreakdown } from '../../app/prepare/lines/breakdown.js';
import { prepareLineRange } from '../../app/prepare/lines/range.js';
import type { ProfileLineType } from '../../app/prepare/lines/types.js';

export type ProfileFixtureOptions = {
    startTime?: number;
    noSourceMap?: boolean;
    fallback?: boolean;
    cpuOnly?: boolean;
    locationsOnly?: boolean;
    stackOnly?: boolean;
    mapping?: number[];
    contexts?: number[];
    allocationGc?: number[];
    allocationSpaces?: number[];
    allocationSpaceNames?: Record<number, string>;
};

export async function createProfileFixture(options: ProfileFixtureOptions = {}) {
    const dictionary = new Dictionary();
    const originalScripts = new OriginalScriptsMap(dictionary);
    const generator = new SourceMapGenerator({ file: 'compiled.js' });
    for (const column of [0, 10, 20]) {
        generator.addMapping({
            generated: { line: 1, column },
            original: { line: column / 10 + 1, column: 0 },
            source: 'original.js'
        });
    }
    const scripts = [{ id: 1, url: '/compiled.js', source: '', sourceMap: options.noSourceMap ? null : JSON.parse(generator.toString()) }];
    const scriptsMap = new ProfileScriptsMap(dictionary, originalScripts, scripts);
    for (const column of [10, 20]) {
        dictionary.resolveLocationIndex(null, scriptsMap.get(1), column, 0, column);
    }
    const data: V8CpuProfile = {
        startTime: options.startTime ?? 0,
        endTime: (options.startTime ?? 0) + 40,
        nodes: [
            { id: 1, callFrame: { scriptId: 0, url: '', functionName: '(root)', lineNumber: -1, columnNumber: -1 }, children: [2, 3] },
            { id: 2, callFrame: { scriptId: 1, url: '/compiled.js', functionName: 'first', lineNumber: 0, columnNumber: 0 } },
            { id: 3, callFrame: { scriptId: 1, url: '/compiled.js', functionName: 'second', lineNumber: 0, columnNumber: 20 } }
        ],
        samples: [2, 3, 2],
        timeDeltas: [10, 10, 10],
        _samplePositions: options.fallback ? undefined : [10, 20, 10],
        _scripts: scripts
    };
    if (!options.cpuOnly) {
        Object.assign(data, {
            _cpuproAllocationMapping: options.locationsOnly ? undefined : options.mapping || [1, 3, 4],
            _cpuproAllocationIds: [1, 2, 3, 4],
            _cpuproAllocationSizes: [16, 32, 48, 64],
            _cpuproAllocationGc: options.allocationGc,
            _cpuproAllocationSpaces: options.allocationSpaces,
            _cpuproAllocationSpaceNames: options.allocationSpaceNames
        });
        if (!options.stackOnly) {
            Object.assign(data, {
                _cpuproAllocationScriptIds: [1, 1, 1, 0],
                _cpuproAllocationLocations: [10, 20, 10, -1],
                _cpuproAllocationContextInfo: options.contexts || [0, 0, 0, 0],
                _cpuproAllocationVmStateNames: { 1: 'gc', 2: 'parser' }
            });
        }
    }

    const profile = await createProfile(data, { dictionary, originalScripts, work: noopWorkHandler });
    return { profile, dictionary, scriptsMap };
}

export async function createLineFixture({
    type = 'timeline', origin = 0, before = 0, after = 0,
    values = new Uint32Array([10, 10, 5]),
    samples = Uint32Array.from(values, (_, index) => index % 2)
}: {
    type?: ProfileLineType;
    origin?: number;
    before?: number;
    after?: number;
    values?: Uint32Array;
    samples?: Uint32Array;
} = {}) {
    const { profile, dictionary } = await createProfileFixture({ cpuOnly: type === 'timeline', noSourceMap: true });
    const line = profile[type]!;
    const population = new Population(samples, values);
    const original = line.breakdowns[0].source;
    const source = {
        ...original,
        sourceIdToNode: Int32Array.from({ length: population.samplesCount.length }, (_, index) =>
            original.sourceIdToNode[index % original.sourceIdToNode.length])
    };
    const trees = await createSampledTreeSet(dictionary, source, noopWorkHandler);
    const populationViewport = new PopulationFiltered(population);
    const populationFiltered = new PopulationFiltered(populationViewport);
    const range = new RangeSelection(line.range.selection.space).view({ start: 0, end: population.cumulativeEnd }, origin);

    line.axisStart = origin - before;
    line.axisStartNoSamples = before;
    line.axisEnd = origin + population.cumulativeEnd + after;
    line.axisEndNoSamples = after;
    line.axisTotal = population.cumulativeEnd;
    line.values = values;
    line.sourceInfo = { nodes: source.nodes.length, samples: samples.length, samplesInterval: 10 };
    line.attributes = [];
    line.filters = new FilterSet();
    line.range = range;
    line.viewport = new RangeView(new RangeSelection(range.selection.space), range.frame, range.extent);
    line.mappings = Object.create(null);
    const breakdown = await createLineBreakdown('call-stack', line, populationFiltered, populationViewport, trees, noopWorkHandler);
    line.breakdowns = [breakdown];
    profile.lines = [line];
    profile.timeline = line.type === 'timeline' ? line : null;
    profile.memline = line.type === 'memline' ? line : null;
    prepareLineRange(line);

    return { profile, line, breakdown };
}
