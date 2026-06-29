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

export async function createSourceMappedBreakdown(
    breakdownName: string,
    line: ProfileLine,
    dictionary: Dictionary,
    scriptsMap: ProfileScriptsMap,
    treeBreakdownBasis: TreeSource<CpuProLocation> | TreeSource<CpuProCallFrame>,
    samples: Uint32Array,
    values: Uint32Array,
    ownership: any,
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

        for (let i = 0; i < dictionary.locations.length; i++) {
            const {
                callFrame: locationCallFrame,
                script,
                line: lineNumber,
                column: columnNumber
            } = dictionary.locations[i];
            const sourceMap = script?.sourceMap;
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
                    const originalScript = scriptsMap.resolveOriginalScript(
                        originalPos.source,
                        sourceMap.sourcesContent?.[scriptIndex] ?? null,
                        script
                    );
                    if (!originalScript.__owner) {
                        originalScript.__owner = true;
                        const fileIndex = ownership?.files?.[originalPos.source]?.[0];
                        const owner = ownership?.areas?.[fileIndex];
                        if (owner) {
                            originalScript.module.owner = dictionary.resolveOwner(owner);
                        }
                    }
                    let origCallFrame = locationCallFrame.__originalCallFrame;
                    if (locationCallFrame.line !== -1 && origCallFrame === undefined) {
                        const callFrameMapping = sourceMapConsumer.originalPositionFor({
                            line: locationCallFrame.line + 1,
                            column: locationCallFrame.column
                        });
                        if (callFrameMapping.source) {
                            origCallFrame = dictionary.resolveCallFrame({
                                functionName: callFrameMapping.name
                                    ? callFrameMapping.name !== locationCallFrame.name
                                        ? '~' + callFrameMapping.name + ' (' + locationCallFrame.name + ')'
                                        : '~' + callFrameMapping.name
                                    : locationCallFrame.name,
                                scriptId: originalScript.id,
                                url: originalScript.url,
                                lineNumber: callFrameMapping.line !== null ? callFrameMapping.line - 1 : -1,
                                columnNumber: callFrameMapping.column !== null ? callFrameMapping.column : -1
                            }, scriptsMap);
                        }
                        locationCallFrame.__originalCallFrame = origCallFrame ?? null;
                    }
                    const locIndex = dictionary.resolveLocationIndex(
                        origCallFrame,
                        origCallFrame ? null : originalScript,
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
