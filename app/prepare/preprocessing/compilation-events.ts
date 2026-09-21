import type { UniformTraceEvent } from '../formats/types.js';
import type { Dictionary } from '../dictionary.js';
import type { CpuProCallFrame, CpuProScript, IProfileScriptsMap } from '../types.js';

export type CompilationEvent = UniformTraceEvent & {
    callFrame: CpuProCallFrame | null;
    data: {
        data: CompilationLocation;
    };
};

type CompilationLocation = {
    scriptId: number;
    start: number;
};

export function processCompilationEvents(
    events: UniformTraceEvent[],
    dictionary: Dictionary,
    scriptsMap: IProfileScriptsMap
): void {
    let prevScriptId = -1;
    let prevScript: CpuProScript | null = null;

    for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
        const event = events[eventIndex] as CompilationEvent;

        if (event.cat !== 'disabled-by-default-v8.compilation_allocations') {
            continue;
        }

        const { scriptId, start: scriptOffset } = event.data.data;

        if (scriptId !== prevScriptId) {
            prevScriptId = scriptId ?? -1;
            prevScript = scriptId === -1 ? null : scriptsMap.get(scriptId) ?? null;
        }

        event.callFrame = prevScript !== null
            ? dictionary.resolveLocation(null, prevScript, scriptOffset).callFrame
            : null;
    }
}
