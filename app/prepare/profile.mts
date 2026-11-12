import type { Model } from '@discoveryjs/discovery';
import type { CpuProCallFrame, CpuProCompilationRecord, CpuProThread, RuntimeCode, V8CpuProfile } from './types.js';
import type { ProfileLine } from './lines/types.js';
import { convertToInt32Array, convertToUint32Array, createInt32Progression } from './misc/utils.js';
import { fixTimeDeltasOrderIfNeeded, processLongTimeDeltas, createTimelineAxis, enumerateLongTimeDeltas, LongTimeDeltas } from './preprocessing/time-deltas.js';
import { processMemoryAllocations } from './preprocessing/memory-allocations.mjs';
import { reparentGcNodes } from './preprocessing/gc-samples.js';
import { createTimeline, createMemline } from './lines/index.mjs';
import { extractCallFramesFromNodes } from './preprocessing/call-frames.js';
import { createNodeIndexById, createNodeScriptOffsets, createNodeParent, GeneratedNodes } from './preprocessing/nodes.js';
import { processCallFrameCodes } from './preprocessing/call-frame-codes.js';
import { resolveCompilationCallFrames } from './preprocessing/compilation-events.js';
import { createLocationsFromScriptOffsets } from './preprocessing/locations.js';
import { detectRuntime } from './misc/detect-runtime.js';
import { createSampledTreeSet } from './computations/sampled-tree-set.js';
import { collectProfileUsedScriptIds, ProfileScriptsMap, scriptOffsetsFromLineColumns } from './preprocessing/scripts.js';
import { SourceMapping } from './preprocessing/source-mapping.js';
import { prepareScriptSources } from './misc/script-function-resolution.js';
import { Dictionary } from './dictionary.js';
import { type Diagnose, diagnoseToConsole } from './diagnostics.js';
import { createLineMapping, mapAllocationsToSamples } from './computations/line-mapping.js';
import { remapSamples } from './preprocessing/samples.js';
import { Population } from './computations/population.js';
import { createSourceMappedBreakdown } from './profile-sm.mjs';
import { prepareLineFilters } from './lines/filters.js';
import { EventSignatures } from './lines/event-signatures.js';
import { PopulationRecords } from './computations/population-records.js';
import { prepareLineRange } from './lines/range.js';
import { noopWorkHandler, WorkHandler } from './misc/work.js';

const experimentalFeatures = false;

export type Profile = Awaited<ReturnType<typeof createProfile>>;
export type CreateProfileOptions = {
    compilations: CpuProCompilationRecord[] | null;
    dictionary: Dictionary;
    scriptsMap: ProfileScriptsMap;
    sourceMapping: SourceMapping;
    runtime: RuntimeCode | null;
    work: WorkHandler;
    diagnose: Diagnose;
};
export type CreateProfileApi = {
    work<T>(name: string, fn: () => T): Promise<T>;
}

type BucketProfileEntry = {
    profile: Profile;
    disabled: boolean;
};
export function toggleProfile(model: Model, profile: Profile) {
    const {
        primaryProfile,
        profiles
    } = model.context as {
        primaryProfile: Profile | null;
        profiles: BucketProfileEntry[];
    };
    const bucketProfileEntry = profiles.find(entry => entry.profile === profile);

    if (!bucketProfileEntry) {
        return false;
    }

    const disable = !bucketProfileEntry.disabled;
    const enabledProfiles = profiles.filter(entry => entry === bucketProfileEntry
        ? entry.disabled // for the profile to toggle, the disabled property will be inverted
        : !entry.disabled
    ).map(entry => entry.profile);

    if (disable && enabledProfiles.length < 2) {
        return false;
    }

    const newPrimaryProfile = disable && bucketProfileEntry.profile === primaryProfile
        ? enabledProfiles[0] || null
        : primaryProfile;

    model.setContext({
        primaryProfile: newPrimaryProfile,
        profiles: profiles.map(entry => ({
            ...entry,
            disabled: entry === bucketProfileEntry ? disable : entry.disabled
        }))
    });

    return true;
}

export async function createProfile(data: V8CpuProfile, options?: Partial<CreateProfileOptions>) {
    const {
        diagnose = diagnoseToConsole,
        dictionary = new Dictionary(diagnose),
        sourceMapping = new SourceMapping(dictionary, null, diagnose),
        scriptsMap: profileScriptsMap = new ProfileScriptsMap(
            dictionary,
            data._scripts,
            diagnose
        ),
        runtime = null,
        compilations = null,
        work = noopWorkHandler
    } = options || {};
    const lines: ProfileLine[] = [];

    // Prepare script sources in advance (if any), so that they are available for line-column
    // and script-offset mapping to functions (call frames).
    // The parsing might be done in a workers, which is not only about performance,
    // but also about memory pressure while parsing large amount of script sources.
    const preparseStart = performance.now();
    const preparseScriptSourcesResult = profileScriptsMap.size > 0
        ? prepareScriptSources(
            profileScriptsMap.getScriptsById(collectProfileUsedScriptIds(data, compilations)),
            diagnose
        ).finally(() => {
            performance.measure('preparseScriptSources', { start: preparseStart });
        })
        : Promise.resolve();

    // The timeline is made of the call tree and samples of a CPU profile, the memline of allocations, so a capture
    // may have either; e.g. a trace without the chunks of its profiler thread has samples without a call tree
    if (data.nodes.length === 0 && data.samples.length > 0) {
        diagnose('warn', 'Ignored CPU samples of a profile with no call tree nodes', {
            samples: data.samples.length
        });
    }

    const callStack = data.nodes.length > 0
        ? await createCallStackTimeline(
            data,
            dictionary,
            profileScriptsMap,
            work,
            diagnose
        )
        : null;
    const timeline = callStack?.timeline ?? null;
    const cpuSamplesPopulation = callStack?.population ?? null;
    const callStackSampledTreeSet = callStack?.sampledTreeSet ?? null;
    const sampleAllocationIds = callStack?.sampleAllocationIds ?? null;
    const allocationSamples = callStack?.allocationSamples ?? null;
    const {
        codes,
        codesByCallFrame,
        codesByScript
    } = callStack?.callFrameCodes ?? {
        codes: [],
        codesByCallFrame: [],
        codesByScript: []
    };

    if (timeline) {
        lines.push(timeline);
    }

    // Original sources of the locations known so far are parsed while the memline is created
    await work('prepare source maps', () => sourceMapping.prepareLocations());

    // Create memline from allocation data if present
    const memline = await createMemline(
        data,
        dictionary,
        profileScriptsMap,
        cpuSamplesPopulation,
        callStackSampledTreeSet,
        allocationSamples,
        preparseScriptSourcesResult,
        { work, compilations }
    );

    if (memline) {
        lines.push(memline);
    }

    // Create mappings between lines if both exist and allocation mapping is present
    if (memline && timeline) {
        if (allocationSamples && sampleAllocationIds) {
            const { left, right } = createLineMapping(
                memline,
                allocationSamples,
                timeline,
                sampleAllocationIds
            );

            memline.mappings.timeline = left;
            timeline.mappings.memline = right;
        }
    }

    // create profile
    const usage = callStackSampledTreeSet?.dictionary || dictionary;
    const profile = {
        name: data._name ?? null,
        // FIXME: categories/packages must be related to profile
        runtime: detectRuntime(
            usage.categories,
            usage.packages,
            runtime || data._runtime
        ),
        thread: null as unknown as CpuProThread, // to be set by caller

        // ...usage,
        ...dictionary,
        codes,
        codesByCallFrame,
        codesByScript,

        // lines
        timeline,
        memline,
        lines,

        // ---- legacy fields ----

        heap: data._heap || null
    };

    for (let i = 0; i < lines.length; i++) {
        lines[i].profile = profile;
    }

    if (compilations) {
        await work('link compilation events', async () => {
            await preparseScriptSourcesResult;
            resolveCompilationCallFrames(compilations, dictionary, profileScriptsMap);
        });
    }

    const originalLocations = await work('process source maps', () => sourceMapping.mapLocations());

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (sourceMapping.hasSourceMaps) {
            // source mapped breakdowns are added to the breakdowns, they're not mapped again
            const breakdownCount = line.breakdowns.length;

            for (let j = 0; j < breakdownCount; j++) {
                const breakdown = line.breakdowns[j];
                const sourceMappedBreakdown = await createSourceMappedBreakdown(
                    `${breakdown.kind}-sm`,
                    line,
                    breakdown,
                    dictionary,
                    originalLocations,
                    work
                );

                if (sourceMappedBreakdown !== null) {
                    line.breakdowns.push(sourceMappedBreakdown);
                }
            }
        }

        prepareLineFilters(line);
        prepareLineRange(line);
        const signatures = await work(`compute ${line.type} event signatures`, () => new EventSignatures(line));
        const classes = signatures.filterClasses;
        const records = new Map<Population, PopulationRecords>();

        line.signatures = signatures;

        for (let j = 0; j < line.breakdowns.length; j++) {
            const {
                population,
                populationViewport,
                populationWindow,
                populationFiltered
            } = line.breakdowns[j];

            if (!records.has(population)) {
                records.set(population, await work(`group ${line.type} events by samples and signatures`, () =>
                    new PopulationRecords(
                        population.samples,
                        population.values,
                        population.cumulative,
                        population.cumulativeEnd,
                        classes
                    )
                ));
            }

            populationViewport.filter.setEventClasses(classes);
            populationWindow.filter.setEventClasses(classes);
            populationViewport.setRecords(records.get(population)!);
            populationWindow.setRecords(records.get(population)!);
            populationFiltered.setRecords(records.get(population)!);
        }
    }

    return profile;
}

// The timeline of call stacks from the call tree and samples of a CPU profile, with codes of its call frames
async function createCallStackTimeline(
    data: V8CpuProfile,
    dictionary: Dictionary,
    profileScriptsMap: ProfileScriptsMap,
    work: WorkHandler,
    diagnose: Diagnose
) {
    const profileType = data._type === 'memory' ? 'memory' as const : 'time' as const;
    const generatedNodes = new GeneratedNodes(dictionary, data.nodes.length);

    // Extract script offset first, since they depends on timestamps order,
    // and should be moved together with timeDeltas if the order is adjusted in fixTimeDeltasOrderIfNeeded()
    const dataScriptOffsets = data._samplePositions?.slice() || await work('extract sample script offsets', () =>
        scriptOffsetsFromLineColumns(
            data.nodes,
            data.samples,
            data._callFrames,
            data._scripts,
            data.lines,
            data.columns
        )
    );

    //
    // Process profile samples & time stamps
    //

    // The input data is not modified, so the vectors following the order of samples are copied
    // before the order is fixed; copies keep the element types of the input vectors
    const dataTimeDeltas = data.timeDeltas.slice();
    const dataSamples = data.samples.slice();
    const allocationMapping = data._cpuproAllocationMapping?.slice() ?? null;

    // preprocess timeDeltas, fix order if necessary
    await work('ensure correct time deltas order', () =>
        fixTimeDeltasOrderIfNeeded(
            dataTimeDeltas,
            dataSamples,
            dataScriptOffsets,
            allocationMapping
        )
    );

    // create samples axis
    const axis = profileType === 'time'
        ? await work('process time deltas', () =>
            createTimelineAxis(
                data.startTime,
                data.endTime,
                dataTimeDeltas,
                data._samplesInterval // could be computed on V8 log convertation into cpuprofile
            )
        )
        : await work('process memory allocations', () =>
            processMemoryAllocations(
                dataTimeDeltas,
                data._samplesInterval // could be computed on profile's preprocessing
            )
        );

    // normalize long samples (time deltas)
    let longDeltas: LongTimeDeltas | null = null;
    if (experimentalFeatures && profileType === 'time') {
        longDeltas = await work('enumerate long time deltas', () =>
            enumerateLongTimeDeltas(
                axis.samplesInterval,
                dataTimeDeltas
            )
        );
    }

    // Allocations recorded after the last CPU sample have no call stack. The profile ends with a sample of no
    // time of the "(after profile end)" call frame: allocations map to it, the sample after the recorded ones,
    // rather than to the last sample's stack, as long gaps without samples are samples of "(no samples)".
    // When the last samples have no recorded allocation ID, the allocations map to them
    const allocationIds = data._cpuproAllocationIds ?? null;
    const sampleAllocationIds = allocationMapping !== null
        ? new Uint32Array(allocationMapping)
        : null;
    let allocationSamples: Uint32Array | null = null;
    let afterProfileSample = false;

    if (allocationIds !== null && sampleAllocationIds !== null) {
        allocationSamples = await work('map allocations to CPU samples', () =>
            mapAllocationsToSamples(allocationIds, sampleAllocationIds, dataSamples.length)
        );

        // A profile without samples has no sample after its end
        if (allocationSamples.length > 0 && dataSamples.length > 0) {
            afterProfileSample = allocationSamples[allocationSamples.length - 1] === dataSamples.length;
        }
    }

    // convert arrays into TypedArrays;
    // after this point these arrays will not change their length
    let extraLength = longDeltas?.longTimeDeltasCount ?? 0;

    if (afterProfileSample) {
        extraLength++;
    }

    const {
        timeDeltas,
        samples,
        sampleScriptOffsets
    } = await work('convert vectors into TypedArrays', () => ({
        timeDeltas: convertToUint32Array(dataTimeDeltas, extraLength),
        samples: convertToUint32Array(dataSamples, extraLength),
        sampleScriptOffsets: Array.isArray(dataScriptOffsets)
            ? convertToInt32Array(dataScriptOffsets, extraLength)
            : null
    }));

    // create node index by id and remap sample node ids to node indices;
    // at this point, only data.nodes use ids for reference to other nodes
    const nodeIndexById = await work('remap samples to node indices', () => {
        const nodeIndexById = createNodeIndexById(data.nodes);

        for (let i = 0; i < samples.length; i++) {
            samples[i] = nodeIndexById[samples[i]];
        }

        return nodeIndexById;
    });

    // The sample of allocations after the profile follows the samples of the profile with no time
    if (afterProfileSample) {
        samples[dataSamples.length] = generatedNodes.addNode(
            dictionary.callFrames.wellKnownIndex['after-profile-end'],
            1, // parentId = root
            -1 // parentScriptOffset
        );

        if (sampleScriptOffsets !== null) {
            sampleScriptOffsets[dataSamples.length] = -1;
        }
    }

    // process long time deltas if needed
    if (longDeltas !== null) {
        await work('process long time deltas', () =>
            processLongTimeDeltas(
                longDeltas,
                timeDeltas,
                samples,
                sampleScriptOffsets,
                generatedNodes
            )
        );
    }

    // attach root GC node samples to previous call stack;
    // this operation produces new nodes
    await work('reparent GC samples', () =>
        reparentGcNodes(
            data.nodes,
            generatedNodes,
            data._callFrames || null,
            samples,
            sampleScriptOffsets
        )
    );

    //
    // Consume dictionaries
    //

    const {
        callFrameByIndex,
        callFrameByNodeIndex
    } = await work('extract call frames', () =>
        extractCallFramesFromNodes(
            dictionary,
            data.nodes,
            data._callFrames,
            profileScriptsMap,
            generatedNodes
        )
    );

    //
    // Create profile's data derivatives
    //

    const nodeParent = await work('process nodes', () =>
        createNodeParent(
            data.nodes,
            nodeIndexById,
            generatedNodes
        )
    );

    const nodeScriptOffsets = await work('create node script offsets', () =>
        createNodeScriptOffsets(
            data.nodes,
            nodeParent,
            generatedNodes,
            callFrameByNodeIndex,
            dictionary
        )
    );

    const callStackBreakdownBasis = await work('create tree source', () =>
        createLocationsFromScriptOffsets(
            dictionary,
            nodeParent,
            nodeScriptOffsets,
            callFrameByNodeIndex,
            samples,
            sampleScriptOffsets
        ) || {
            parent: nodeParent,
            sourceIdToNode: createInt32Progression(nodeParent.length),
            nodes: callFrameByNodeIndex,
            dictionary: dictionary.callFrames as CpuProCallFrame[]
        }
    );

    const { samples: callStackSamples, sampleToNode } = await work('normalize CPU samples', () =>
        remapSamples(samples, callStackBreakdownBasis.sourceIdToNode)
    );
    const callStackSource = {
        ...callStackBreakdownBasis,
        sourceIdToNode: sampleToNode
    };
    const cpuSamplesPopulation = await work('create CPU population', () =>
        callStackSamples.length > 0
            ? new Population(callStackSamples, timeDeltas)
            : null
    );
    const callStackSampledTreeSet = cpuSamplesPopulation
        ? await work('create tree breakdown', () =>
            createSampledTreeSet(
                dictionary,
                callStackSource,
                work
            )
        )
        : null;

    // Create timeline (CPU time profiling line)
    const timeline = cpuSamplesPopulation && callStackSampledTreeSet
        ? await createTimeline(
            data,
            axis,
            cpuSamplesPopulation,
            callStackSampledTreeSet,
            { work }
        )
        : null;

    // process function codes
    const callFrameCodes = await work('process function codes', () =>
        processCallFrameCodes(
            data._callFrameCodes,
            callFrameByIndex,
            dictionary.callFrames,
            axis.start,
            axis.end,
            diagnose
        )
    );

    return {
        timeline,
        population: cpuSamplesPopulation,
        sampledTreeSet: callStackSampledTreeSet,
        sampleAllocationIds,
        allocationSamples,
        callFrameCodes
    };
}
