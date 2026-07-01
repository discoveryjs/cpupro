import { SourceMapConsumer } from 'source-map-js';
import { Dictionary } from './dictionary.js';
import { createSampledTreeSet } from './profile.mjs';
import { ProfileScriptsMap } from './preprocessing/scripts.js';
import { CpuProCallFrame, CpuProLocation, CpuProScript } from './types.js';
import { TreeSource } from './computations/build-trees.js';
import { createLineBreakdown } from './lines/trees.js';
import { ProfileLine } from './lines/types.js';
import { WorkHandler } from './misc/work.js';
import { createInt32Progression } from './misc/utils.js';
import { Ownership } from './formats/types.js';

export async function createSourceMappedBreakdown(
    breakdownName: string,
    line: ProfileLine,
    dictionary: Dictionary,
    scriptsMap: ProfileScriptsMap,
    treeBreakdownBasis: TreeSource<CpuProLocation> | TreeSource<CpuProCallFrame>,
    samples: Uint32Array,
    values: Uint32Array,
    ownership: Ownership | null,
    work: WorkHandler
) {
    if (treeBreakdownBasis.dictionary !== dictionary.locations) {
        return;
    }

    if (!dictionary.locations.some(loc => loc.script?.sourceMap)) {
        return;
    }

    const startTime = Date.now();
    const execToOriginalMap = await work('process source maps', () => {
        const smByScript = new Map<CpuProScript, SourceMapConsumer>();
        const execToOriginalMap = createInt32Progression(dictionary.locations.length);
        let resolved = 0;
        let notResolved = 0;
        let noLC = 0;
        let noMap = 0;

        console.log('->>> locations', dictionary.locations.length, 'callFrames', dictionary.callFrames.length);

        for (let i = 0; i < dictionary.callFrames.length; i++) {
            const callFrame = dictionary.callFrames[i];
            const script = callFrame.script;
            if (callFrame.__originalCallFrame === undefined && script && script.sourceMap && callFrame.line !== -1 && callFrame.column !== -1) {
                const sourceMap = script.sourceMap;
                const sourceMapConsumer = smByScript.getOrInsertComputed(
                    script,
                    () => {
                        return sourceMap.xxx || (sourceMap.xxx = new SourceMapConsumer(sourceMap));
                    }
                );
                const originalPos = sourceMapConsumer.originalPositionFor({
                    line: callFrame.line + 1,
                    column: callFrame.column
                });
                if (originalPos.source) {
                    const scriptIndex = sourceMap.xxx._absoluteSources.indexOf(originalPos.source);
                    const originalScript = scriptsMap.resolveOriginalScript(
                        originalPos.source,
                        sourceMap.sourcesContent?.[scriptIndex] ?? null,
                        script
                    );
                    let origCallFrame = callFrame.__originalCallFrame;
                    if (origCallFrame === undefined) {
                        origCallFrame = dictionary.resolveCallFrame({
                            functionName: originalPos.name
                                ? originalPos.name !== callFrame.name
                                    ? '~' + originalPos.name + ' (' + callFrame.name + ')'
                                    : '~' + originalPos.name
                                : callFrame.name,
                            scriptId: originalScript.id,
                            url: originalScript.url,
                            lineNumber: originalPos.line !== null ? originalPos.line - 1 : -1,
                            columnNumber: originalPos.column !== null ? originalPos.column : -1
                        }, scriptsMap);
                        callFrame.__originalCallFrame = origCallFrame ?? null;
                    }
                }
            }
        }

        for (let i = 0; i < dictionary.locations.length; i++) {
            const location = dictionary.locations[i];
            const {
                callFrame: locationCallFrame,
                script,
                line: lineNumber,
                column: columnNumber
            } = location;

            if (locationCallFrame.location === location) {
                if (locationCallFrame.__originalCallFrame) {
                    execToOriginalMap[i] = locationCallFrame.__originalCallFrame.location.id - 1;
                }
                continue;
            }

            const sourceMap = script?.sourceMap;
            if (lineNumber < -1) {
                notResolved++;
                console.warn('Invalid line number for location', i, lineNumber, columnNumber, script?.url, dictionary.locations[i]);
                continue;
            }
            if (script && sourceMap && lineNumber !== -1 && columnNumber !== -1) {
                const sourceMapConsumer = smByScript.getOrInsertComputed(
                    script,
                    () => {
                        return sourceMap.xxx || (sourceMap.xxx = new SourceMapConsumer(sourceMap));
                    }
                );
                const originalPos = sourceMapConsumer.originalPositionFor({
                    line: lineNumber + 1,
                    column: columnNumber
                });
                if (originalPos.source) {
                    const scriptIndex = sourceMap.xxx._absoluteSources.indexOf(originalPos.source);
                    const origCallFrame = locationCallFrame.__originalCallFrame;
                    const originalScript = origCallFrame?.script || scriptsMap.resolveOriginalScript(
                        originalPos.source,
                        sourceMap.sourcesContent?.[scriptIndex] ?? null,
                        script
                    );
                    const locIndex = dictionary.resolveLocationIndex(
                        origCallFrame,
                        originalScript,
                        -1,
                        originalPos.line !== null ? originalPos.line - 1 : -1,
                        originalPos.column !== null ? originalPos.column : -1
                    );

                    // console.log(execToOriginalMap[i] ,'->', locIndex);
                    execToOriginalMap[i] = locIndex;
                    resolved++;
                } else {
                    notResolved++;
                }
            } else if (script && sourceMap) {
                noLC++;
            } else {
                noMap++;
            }
        }
        console.log({
            resolved,
            notResolved,
            noLC,
            noMap,
            total: resolved + notResolved + noLC + noMap,
            callFrames: dictionary.callFrames.length,
            locations: dictionary.locations.length,
            time: Date.now() - startTime
        });

        return execToOriginalMap;
    });
    // apply ownership to original scripts
    for (const [id, script] of scriptsMap.entries()) {
        if (script.originalFor && !script.__owner) {
            const originalScript = script;
            const fileIndex = ownership?.files?.[script.url]?.[0];
            const owner = typeof fileIndex === 'number' ? ownership?.areas?.[fileIndex] : null;

            script.__owner = true;
            if (owner) {
                originalScript.module.owner = dictionary.resolveOwner(owner);
            }
        }
    }

    const sampledTreeSet = await createSampledTreeSet(
        dictionary,
        {
            ...treeBreakdownBasis,
            nodes: treeBreakdownBasis.nodes.map(x => execToOriginalMap[x])
        },
        samples,
        work
    );

    const breakdown = await createLineBreakdown(
        breakdownName,
        line,
        values,
        sampledTreeSet,
        work
    );

    line.breakdowns.push(breakdown);

    console.log('createSourceMappedBreakdown', Date.now() - startTime);
}
