import { ScriptCompilation, scriptCompilationStates } from '../prepare/preprocessing/script-compilation.js';
import { prepareScriptSources } from '../prepare/misc/script-function-resolution.js';
import type { CpuProScript } from '../prepare/types.js';

export async function parseScriptSources<T extends { script: CpuProScript | null }>(entries: T[]) {
    await prepareScriptSources(entries.flatMap(({ script }) => script ? [script] : []));

    return entries;
}

export function scriptSourceSummary(script: CpuProScript, compilation: ScriptCompilation | null = null, hasCompilationData = compilation !== null) {
    const { sourceMetrics = null, functionRanges } = script;
    const ranges = functionRanges ?? [];
    const stateSizes = sourceMetrics !== null && sourceMetrics.selfSize !== null
        ? new Array<number>(scriptCompilationStates.length).fill(0)
        : null;
    let functions = 0;

    if (stateSizes) {
        stateSizes[compilation?.states[0] ?? 0] += sourceMetrics!.selfSize! * sourceMetrics!.bytesPerChar;

        for (let index = 0; index < ranges.length; index++) {
            const range = ranges[index];
            const isClass = range.type === 'ClassDeclaration' || range.type === 'ClassExpression';

            if ((!isClass || range.defaultConstructor) &&
                range.type !== 'TSEnumDeclaration' &&
                range.type !== 'TSDeclareFunction'
            ) {
                functions++;
            }

            stateSizes[compilation?.states[index + 1] ?? 0] += range.selfSize * sourceMetrics!.bytesPerChar;
        }
    }

    return {
        script,
        compilation,
        byteLength: sourceMetrics?.byteLength ?? null,
        bytesPerChar: sourceMetrics?.bytesPerChar ?? null,
        functions: stateSizes ? functions : null,
        stateSizes,
        compiledBytes: stateSizes && hasCompilationData && !script.originalFor ? stateSizes[3] + stateSizes[4] : null,
        observed: compilation !== null,
        unmatched: compilation?.unmatchedStarts.length ?? 0,
        unknownStages: compilation?.unknownStages ?? [],
        states: stateSizes ? scriptCompilationStates.map((name, index) => ({ name, bytes: stateSizes[index] })) : []
    };
}

export function scriptSourceFunctions(script: CpuProScript, compilation: ScriptCompilation | null = null) {
    if (script.sourceMetrics?.selfSize === null || !script.sourceMetrics || !script.functionRanges) {
        return [];
    }

    const { bytesPerChar, selfSize } = script.sourceMetrics;

    return [{
        script,
        name: '(script)',
        type: 'Script',
        start: 0,
        end: script.source!.length,
        selfSize,
        ownBytes: selfSize * bytesPerChar,
        state: scriptCompilationStates[compilation?.states[0] ?? 0]
    }, ...script.functionRanges.map((range, index) => ({
        script,
        name: range.name || '(anonymous)',
        type: range.type,
        start: range.callFrameStart,
        end: range.end,
        selfSize: range.selfSize,
        ownBytes: range.selfSize * bytesPerChar,
        state: scriptCompilationStates[compilation?.states[index + 1] ?? 0]
    }))];
}
