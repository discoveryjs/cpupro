import type { CpuProCompilationRecord, CpuProCompilationSubject, CpuProScript, CpuProThread, IProfileScriptsMap } from '../types.js';
import type { FunctionRange } from '../misc/parse-script-source-ranges.js';
import type { ProfileScriptsMap } from './scripts.js';
import { isScriptCompilationRecord } from './compilation-events.js';

export const scriptCompilationStates = ['unobserved', 'pre-parsed', 'parsed', 'compiled', 'optimized'] as const;

export type ScriptCompilation = {
    states: Uint8Array;
    unmatchedStarts: (number | null)[];
    unknownStages: string[];
};

const stageStates = new Map<string, number | null>([
    ['GetSharedFunctionInfoForScript', null],
    ['GetSharedFunctionInfoForStreamedScript', null],
    ['CollectSourcePositions', 2],
    ['PreParse', 1],
    ['PreParseCached', 1],
    ['ParseProgram', 2],
    ['ParseFunction', 2],
    ['Compile', 3],
    ['CompileCode', 3],
    ['CompileFunction', 3],
    ['CompileUnoptimized', 3],
    ['CompileIgnition', 3],
    ['FinalizeUnoptimizedCompilationJob', 3],
    ['FinalizeUnoptimizedCompilation', 3],
    ['InstallBaselineCode', 3],
    ['FinishOffThreadDeserialize', 3],
    ['FinalizeDeserialization', 3],
    ['FinalizeBackgroundScript', 3],
    ['CompileMaglev', 3],
    ['MaglevConcurrentPrepare', 3],
    ['CompileOptimized', 3],
    ['CompileOptimizedOSR', 3],
    ['Turbofan.OptimizeConcurrentPrepare', 3],
    ['FinalizeMaglevCompilationJob', 4],
    ['Turbofan.OptimizeCode', 4],
    ['Turbofan.OptimizeConcurrentFinalize', 4]
]);

export function prepareCompilationSubjects(records: CpuProCompilationRecord[]): CpuProCompilationSubject[] {
    const subjects: CpuProCompilationSubject[] = [];
    const subjectIndexes = new Map<string, number>();
    const states: number[] = [];

    for (const record of records) {
        const key = record.scriptId + ':' + record.start;
        let index = subjectIndexes.get(key);

        if (index === undefined) {
            index = subjects.length;
            subjectIndexes.set(key, index);
            states.push(0);
            subjects.push({
                subject: key,
                scriptId: record.scriptId,
                start: record.start,
                callFrame: null,
                state: scriptCompilationStates[0],
                activated: false,
                sourceSize: null,
                records: [],
                events: 0
            });
        }

        const subject = subjects[index];

        subject.records.push(record);
        subject.events++;
        subject.callFrame ??= record.callFrame;

        if (record.duration !== null) {
            states[index] = Math.max(states[index], stageStates.get(record.name) ?? 0);
        }
    }

    for (let index = 0; index < subjects.length; index++) {
        const subject = subjects[index];
        const frame = subject.callFrame;
        const state = states[index];

        subject.state = scriptCompilationStates[state];

        if (frame === null) {
            continue;
        }

        subject.activated = frame.kind === 'function' && state >= 3;

        const metrics = frame.script?.sourceMetrics;

        if (metrics && frame.start >= 0 && frame.end > frame.start) {
            subject.sourceSize = (frame.end - frame.start) * metrics.bytesPerChar;
        }
    }

    return subjects;
}

function resolveCompilationStateIndex(
    record: CpuProCompilationRecord,
    script: CpuProScript,
    ranges: FunctionRange[],
    byStart: Map<number, number[]>
) {
    const wholeScript = record.start === 0 && record.end === script.source?.length;

    if (wholeScript && isScriptCompilationRecord(record)) {
        return 0;
    }

    const candidates = record.start === null ? undefined : byStart.get(record.start);
    let matchedIndex = -1;

    if (candidates) {
        for (const index of candidates) {
            const range = ranges[index];
            const matchingEnd = range.end === record.end;
            const defaultConstructor = range.defaultConstructor && record.end === record.start;

            if (!matchingEnd && !defaultConstructor) {
                continue;
            }

            if (matchedIndex !== -1) {
                return -1;
            }

            matchedIndex = index + 1;
        }
    }

    return matchedIndex === -1 && wholeScript ? 0 : matchedIndex;
}

export function processScriptCompilation(records: CpuProCompilationRecord[], scripts: IProfileScriptsMap) {
    const recordsByScript = new Map<number, CpuProCompilationRecord[]>();
    const result = new Map<number, ScriptCompilation>();

    for (const record of records) {
        const script = record.scriptId !== null
            ? scripts.get(record.scriptId)
            : undefined;

        if (script && record.scriptId !== null) {
            let entries = recordsByScript.get(record.scriptId);

            if (!entries) {
                recordsByScript.set(record.scriptId, entries = []);
            }

            entries.push(record);
        }
    }

    for (const [scriptId, entries] of recordsByScript) {
        const script = scripts.get(scriptId)!;
        const ranges = script.functionRanges;

        if (ranges === null || script.sourceMetrics?.selfSize === null) {
            continue;
        }

        const compilation: ScriptCompilation = {
            states: new Uint8Array(ranges.length + 1),
            unmatchedStarts: [],
            unknownStages: []
        };
        const byStart = new Map<number, number[]>();
        const unmatchedStarts = new Set<number | null>();
        const unknownStages = new Set<string>();

        for (let index = 0; index < ranges.length; index++) {
            const { callFrameStart } = ranges[index];
            const matches = byStart.get(callFrameStart);

            if (matches) {
                matches.push(index);
            } else {
                byStart.set(callFrameStart, [index]);
            }
        }

        for (const record of entries) {
            const state = stageStates.get(record.name);

            if (state === undefined) {
                unknownStages.add(record.name);
                continue;
            }

            if (state === null || record.duration === null) {
                continue;
            }

            const index = resolveCompilationStateIndex(record, script, ranges, byStart);

            if (index === -1) {
                unmatchedStarts.add(record.start);
            } else {
                compilation.states[index] = Math.max(compilation.states[index], state);
            }
        }

        compilation.unmatchedStarts = [...unmatchedStarts];
        compilation.unknownStages = [...unknownStages];
        result.set(scriptId, compilation);
    }

    return result;
}

export function linkThreadScripts(thread: CpuProThread, scripts: ProfileScriptsMap) {
    const compilations = processScriptCompilation(thread.compilations ?? [], scripts);
    const linked = new Set<CpuProScript>();

    thread.compilationSubjects = prepareCompilationSubjects(thread.compilations ?? []);

    for (const entry of thread.scripts) {
        const script = scripts.get(entry.id);

        if (script) {
            entry.script = script;
            entry.compilation = typeof entry.id === 'number'
                ? compilations.get(entry.id) ?? null
                : null;
        }

        if (entry.script) {
            linked.add(entry.script);
        }
    }

    for (const [id, script] of scripts.entries()) {
        if (!linked.has(script) && typeof id === 'number' && compilations.has(id)) {
            scripts.diagnose('warn', 'Script is missing in thread scripts', {
                scriptId: id,
                url: script.url
            });
            linked.add(script);
            thread.scripts.push({
                id,
                url: script.url,
                source: script.source,
                script,
                compilation: compilations.get(id) ?? null
            });
        }
    }
}
