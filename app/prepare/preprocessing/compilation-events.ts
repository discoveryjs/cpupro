import type { Dictionary } from '../dictionary.js';
import type { UniformTraceEvent } from '../formats/types.js';
import type { CpuProCallFrame, CpuProScript, IProfileScriptsMap, V8CompilationEvent, V8CpuProfileCpuproExtensions } from '../types.js';
import { getNumericArrayOrder, lowerBound, type NumericArrayOrder } from '../computations/misc.js';

export type CompilationEvent = V8CompilationEvent & {
    callFrame: CpuProCallFrame | null;
    selfTime: number;
};

export type PreparedCompilationEvents = NonNullable<ReturnType<typeof prepareCompilationEvents>>;

export function prepareCompilationEvents(data: V8CpuProfileCpuproExtensions) {
    const { _events: events, _cpuproAllocationIds: allocationIds, _cpuproAllocationIdsOrder } = data;

    if (!Array.isArray(events) || events.length === 0) {
        return null;
    }

    const owners: ({ scriptId: number; start: number } | null)[] = [null];
    const stages = ['none'];
    const ownerByScript = new Map<number, Map<number, number>>();
    const stageByName = new Map<string, number>();
    const stack: CompilationEvent[] = [];
    let eventOwners: Uint32Array | null = null;
    let eventOrder: number[] | null = null;
    let previousEvent: CompilationEvent | null = null;
    let ordered = true;

    // Keep source indices and raw owner identities until frames can be resolved.
    // Zero skips unrelated events; allocate the vector only when compilation is present.
    for (let index = 0; index < events.length; index++) {
        const event = events[index] as CompilationEvent;

        if (event.cat !== 'disabled-by-default-v8.compilation_allocations') {
            continue;
        }

        const { scriptId, start } = event.data.data;
        let ownerByStart = ownerByScript.get(scriptId);

        if (ownerByStart === undefined) {
            ownerByScript.set(scriptId, ownerByStart = new Map());
        }

        let ownerIndex = ownerByStart.get(start);

        if (ownerIndex === undefined) {
            ownerIndex = owners.length;
            ownerByStart.set(start, ownerIndex);
            owners.push({ scriptId, start });
        }

        eventOwners ??= new Uint32Array(events.length);
        eventOwners[index] = ownerIndex;
        event.selfTime = event.duration;

        if (!stageByName.has(event.name)) {
            stageByName.set(event.name, stages.length);
            stages.push(event.name);
        }

        if (previousEvent !== null &&
            (previousEvent.tm > event.tm || (previousEvent.tm === event.tm && previousEvent.duration < event.duration))) {
            ordered = false;
        }

        previousEvent = event;
    }

    if (eventOwners === null) {
        return null;
    }

    // Tracing sorts timestamps, but equal starts must put parents before children.
    // Reorder only a temporary index, never the shared thread events.
    if (!ordered) {
        eventOrder = [];

        for (let index = 0; index < events.length; index++) {
            if (eventOwners[index] !== 0) {
                eventOrder.push(index);
            }
        }

        eventOrder.sort((left, right) => events[left].tm - events[right].tm || events[right].duration - events[left].duration);
    }

    const eventCount = eventOrder === null ? events.length : eventOrder.length;

    for (let index = 0; index < eventCount; index++) {
        const eventIndex = eventOrder === null ? index : eventOrder[index];

        if (eventOwners[eventIndex] === 0) {
            continue;
        }

        const event = events[eventIndex] as CompilationEvent;

        while (stack.length && event.tm >= stack[stack.length - 1].tm + stack[stack.length - 1].duration) {
            stack.pop();
        }

        const parent = stack[stack.length - 1];

        if (parent) {
            parent.selfTime -= event.duration;
        }

        if (event.duration > 0) {
            stack.push(event);
        }
    }

    const allocations = allocationIds
        ? prepareCompilationAllocations(
            events,
            eventOrder,
            eventOwners,
            stageByName,
            allocationIds,
            _cpuproAllocationIdsOrder ?? getNumericArrayOrder(allocationIds)
        )
        : null;

    return {
        events,
        eventOwners,
        owners,
        callFrames: new Array<CpuProCallFrame | null>(owners.length).fill(null),
        stages,
        allocationOwners: allocations?.allocationOwners ?? null,
        allocationStages: allocations?.allocationStages ?? null
    };
}

function prepareCompilationAllocations(
    events: UniformTraceEvent[],
    eventOrder: number[] | null,
    eventOwners: Uint32Array,
    stageByName: Map<string, number>,
    allocationIds: ArrayLike<number>,
    allocationIdsOrder: NumericArrayOrder
) {
    const count = allocationIds.length;
    const firstId = allocationIds[0];
    const allocationOwners = new Uint32Array(count);
    const allocationStages = stageByName.size < 256 ? new Uint8Array(count) : new Uint32Array(count);
    const consecutiveIds = allocationIdsOrder === 'consecutive';
    const eventCount = eventOrder === null ? events.length : eventOrder.length;
    let orderedIds = allocationIds;
    let allocationOrder: Uint32Array | null = null;

    // Preserve allocation-row alignment: only unordered IDs need a temporary permutation.
    if (allocationIdsOrder === 'unordered') {
        allocationOrder = Uint32Array.from({ length: count }, (_, index) => index);
        allocationOrder.sort((left, right) => allocationIds[left] - allocationIds[right]);
        orderedIds = Float64Array.from(allocationOrder, index => allocationIds[index]);
    }

    for (let index = 0; index < eventCount; index++) {
        const eventIndex = eventOrder === null ? index : eventOrder[index];
        const ownerIndex = eventOwners[eventIndex];

        if (ownerIndex === 0) {
            continue;
        }

        const event = events[eventIndex] as CompilationEvent;
        const { startAllocationId, endAllocationId } = event.data.data;

        if (startAllocationId === endAllocationId) {
            continue;
        }

        // Membership is (startId, endId]; both row boundaries are upper bounds.
        const start = consecutiveIds
            ? Math.max(0, Math.min(count, startAllocationId - firstId + 1))
            : lowerBound(orderedIds, startAllocationId, true);
        const end = consecutiveIds
            ? Math.max(0, Math.min(count, endAllocationId - firstId + 1))
            : lowerBound(orderedIds, endAllocationId, true);
        const stageIndex = stageByName.get(event.name)!;

        if (allocationOrder === null) {
            allocationOwners.fill(ownerIndex, start, end);
            allocationStages.fill(stageIndex, start, end);
        } else {
            for (let offset = start; offset < end; offset++) {
                const allocationIndex = allocationOrder[offset];

                allocationOwners[allocationIndex] = ownerIndex;
                allocationStages[allocationIndex] = stageIndex;
            }
        }
    }

    return { allocationOwners, allocationStages };
}

export function resolveCompilationOwners(
    compilation: PreparedCompilationEvents,
    dictionary: Dictionary,
    scriptsMap: IProfileScriptsMap
) {
    const { owners, callFrames, events, eventOwners } = compilation;
    let prevScriptId = -1;
    let prevScript: CpuProScript | null = null;

    // Distinct raw coordinates may resolve to the same frame. Keep slots unchanged
    // because allocation vectors already refer to these indices.
    for (let index = 1; index < owners.length; index++) {
        const { scriptId, start } = owners[index]!;

        if (scriptId !== prevScriptId) {
            prevScriptId = scriptId;
            prevScript = scriptsMap.get(scriptId) ?? null;
        }

        callFrames[index] = prevScript !== null
            ? dictionary.resolveLocation(null, prevScript, start).callFrame
            : null;
    }

    for (let index = 0; index < events.length; index++) {
        const ownerIndex = eventOwners[index];

        if (ownerIndex !== 0) {
            (events[index] as CompilationEvent).callFrame = callFrames[ownerIndex];
        }
    }
}
