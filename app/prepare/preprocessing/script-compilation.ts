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

// Subjects of the compilation records of a thread, the functions compiled, by script and start, with the state
// of the latest stage reached. The call frame of a subject and what follows from it are known once the call frames
// of the records are resolved (completeCompilationSubjects)
export function prepareCompilationSubjects(records: CpuProCompilationRecord[]): CpuProCompilationSubject[] {
    const subjects: CpuProCompilationSubject[] = [];
    const subjectIndexes = new Map<number | null, Map<number | null, number>>(); // script id → start → subject
    const states: number[] = [];

    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        let subjectsByStart = subjectIndexes.get(record.scriptId);

        if (subjectsByStart === undefined) {
            subjectsByStart = new Map();
            subjectIndexes.set(record.scriptId, subjectsByStart);
        }

        // PERF: Subjects are found by numbers rather than by a key string built for every record
        let index = subjectsByStart.get(record.start);

        if (index === undefined) {
            index = subjects.length;
            subjectsByStart.set(record.start, index);
            states.push(0);
            subjects.push({
                subject: record.scriptId + ':' + record.start,
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

        if (record.duration !== null) {
            states[index] = Math.max(states[index], stageStates.get(record.name) ?? 0);
        }
    }

    for (let i = 0; i < subjects.length; i++) {
        subjects[i].state = scriptCompilationStates[states[i]];
    }

    return subjects;
}

// The call frame of a subject is the first one of its records; a function compiled at least to bytecode is activated
export function completeCompilationSubjects(subjects: CpuProCompilationSubject[]) {
    for (let i = 0; i < subjects.length; i++) {
        const subject = subjects[i];
        const { records } = subject;

        for (let j = 0; j < records.length; j++) {
            if (records[j].callFrame !== null) {
                subject.callFrame = records[j].callFrame;
                break;
            }
        }

        const frame = subject.callFrame;

        if (frame === null) {
            continue;
        }

        const compiled = subject.state === 'compiled' || subject.state === 'optimized';

        subject.activated = frame.kind === 'function' && compiled;

        const metrics = frame.script?.sourceMetrics;

        if (metrics && frame.start >= 0 && frame.end > frame.start) {
            subject.sourceSize = (frame.end - frame.start) * metrics.bytesPerChar;
        }
    }
}

function resolveCompilationStateIndex(
    record: CpuProCompilationRecord,
    script: CpuProScript,
    ranges: FunctionRange[],
    candidates: number[] | undefined // ranges of the record's start
) {
    const wholeScript = record.start === 0 && record.end === script.source?.length;

    if (wholeScript && isScriptCompilationRecord(record)) {
        return 0;
    }

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

export function processScriptCompilation(subjects: CpuProCompilationSubject[], scripts: IProfileScriptsMap) {
    const subjectsByScript = new Map<number, CpuProCompilationSubject[]>();
    const result = new Map<number, ScriptCompilation>();
    const missingScriptIds = new Set<number>();

    for (let i = 0; i < subjects.length; i++) {
        const subject = subjects[i];

        if (subject.scriptId === null) {
            continue;
        }

        if (scripts.get(subject.scriptId) === undefined) {
            // records of a profile given with its scripts refer to a script id it doesn't have
            if (subject.scriptId > 0 && scripts.inputScripts.size > 0) {
                if (!missingScriptIds.has(subject.scriptId)) {
                    missingScriptIds.add(subject.scriptId);
                    scripts.diagnose('warn', 'Script not found for id', { scriptId: subject.scriptId });
                }
            }

            continue;
        }

        let scriptSubjects = subjectsByScript.get(subject.scriptId);

        if (scriptSubjects === undefined) {
            scriptSubjects = [];
            subjectsByScript.set(subject.scriptId, scriptSubjects);
        }

        scriptSubjects.push(subject);
    }

    for (const [scriptId, scriptSubjects] of subjectsByScript) {
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

        for (let i = 0; i < ranges.length; i++) {
            const { callFrameStart } = ranges[i];
            const matches = byStart.get(callFrameStart);

            if (matches) {
                matches.push(i);
            } else {
                byStart.set(callFrameStart, [i]);
            }
        }

        for (let i = 0; i < scriptSubjects.length; i++) {
            const { start, records } = scriptSubjects[i];
            const candidates = start === null ? undefined : byStart.get(start);

            for (let j = 0; j < records.length; j++) {
                const record = records[j];
                const state = stageStates.get(record.name);

                if (state === undefined) {
                    unknownStages.add(record.name);
                    continue;
                }

                if (state === null || record.duration === null) {
                    continue;
                }

                const index = resolveCompilationStateIndex(record, script, ranges, candidates);

                if (index === -1) {
                    unmatchedStarts.add(record.start);
                } else {
                    compilation.states[index] = Math.max(compilation.states[index], state);
                }
            }
        }

        compilation.unmatchedStarts = [...unmatchedStarts];
        compilation.unknownStages = [...unknownStages];
        result.set(scriptId, compilation);
    }

    return result;
}

// Scripts of a thread with the compilation states of their functions, once the call frames of its compilation
// records are resolved; the compilation subjects take their call frames
export function linkThreadScripts(thread: CpuProThread, scripts: ProfileScriptsMap) {
    const subjects = thread.compilationSubjects ?? [];
    const compilations = processScriptCompilation(subjects, scripts);
    const linked = new Set<CpuProScript>();

    completeCompilationSubjects(subjects);

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
                script,
                compilation: compilations.get(id) ?? null
            });
        }
    }
}
