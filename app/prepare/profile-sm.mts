import { SourceMapConsumer } from 'source-map-js';
import { SourceMapConsumer as OwnSourceMapConsumer } from './misc/tmp/source-maps/source-map-consumer.js';
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
import { prepareScriptSources } from './misc/script-function-resolution.js';

function getOriginalPositionFor(sourceMap: SourceMapConsumer, line: number, column: number) {
    let consumer = sourceMap.__consumer;
    if (consumer === undefined) {
        consumer = sourceMap.__consumer = new OwnSourceMapConsumer(sourceMap);
    }

    const originalPos = consumer.originalPositionFor({
        line: line + 1,
        column: column
    });

    // const external = sourceMap.xxx || (sourceMap.xxx = new SourceMapConsumer(sourceMap));
    // const originalPos = external.originalPositionFor({
    //     line: line + 1,
    //     column: column
    // });
    // if (originalPos.source !== shadow.source ||
    //     originalPos.line !== shadow.line ||
    //     originalPos.column !== shadow.column ||
    //     originalPos.name !== shadow.name) {
    //     console.warn('***** SourceMapConsumer mismatch', {
    //         line,
    //         column,
    //         official: originalPos,
    //         own: shadow
    //     });
    // }

    return originalPos;
}

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
    const execToOriginalMap = await work('process source maps', async () => {
        const execToOriginalMap = createInt32Progression(dictionary.locations.length);
        let resolved = 0;
        let notResolved = 0;
        let noLC = 0;
        let noMap = 0;

        console.log('->>> locations', dictionary.locations.length, 'callFrames', dictionary.callFrames.length);

        const callFramesToResolve: {
            callFrame: CpuProCallFrame;
            originalPos: {
                source: string | null;
                line: number | null;
                column: number | null;
                name: string | null;
            };
            originalScript: CpuProScript;
        }[] = [];
        const ensureScriptIsParsed = new Set<CpuProScript>();
        for (let i = 0; i < dictionary.callFrames.length; i++) {
            const callFrame = dictionary.callFrames[i];
            const script = callFrame.script;
            if (callFrame.__originalCallFrame === undefined && // is not inited
                script &&
                script.sourceMap &&
                callFrame.line !== -1 &&
                callFrame.column !== -1) {
                const sourceMap = script.sourceMap;
                const originalPos = getOriginalPositionFor(sourceMap, callFrame.line, callFrame.column);

                if (originalPos.source) {
                    const scriptIndex = sourceMap.__consumer._absoluteSources.get(originalPos.source);
                    const originalScript = scriptsMap.resolveOriginalScript(
                        originalPos.source,
                        sourceMap.sourcesContent?.[scriptIndex] ?? null,
                        script
                    );

                    ensureScriptIsParsed.add(originalScript);
                    callFramesToResolve.push({
                        callFrame,
                        originalPos,
                        originalScript
                    });

                    // origCallFrame = dictionary.resolveCallFrame({
                    //     functionName: originalPos.name
                    //         ? originalPos.name !== callFrame.name
                    //             ? '~' + originalPos.name + ' (' + callFrame.name + ')'
                    //             : '~' + originalPos.name
                    //         : callFrame.name,
                    //     scriptId: originalScript.id,
                    //     url: originalScript.url,
                    //     lineNumber: originalPos.line !== null ? originalPos.line - 1 : -1,
                    //     columnNumber: originalPos.column !== null ? originalPos.column : -1
                    // }, scriptsMap);
                }

                callFrame.__originalCallFrame = null;
            }
        }

        console.log('~~~', ensureScriptIsParsed);
        await prepareScriptSources(ensureScriptIsParsed);
        for (const { callFrame, originalPos, originalScript } of callFramesToResolve) {
            callFrame.__originalCallFrame = dictionary.resolveCallFrame({
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
        }


        const locationToResolve: {
            i: number;
            originalPos: {
                source: string | null;
                line: number | null;
                column: number | null;
                name: string | null;
            };
            originalScript: CpuProScript;
            origCallFrame: CpuProCallFrame | null;
        }[] = [];
        for (let i = 0; i < dictionary.locations.length; i++) {
            const location = dictionary.locations[i];
            const {
                __originalLocation,
                callFrame: locationCallFrame,
                script,
                line: lineNumber,
                column: columnNumber
            } = location;

            if (__originalLocation === null) {
                continue;
            }

            if (__originalLocation) {
                execToOriginalMap[i] = __originalLocation.id - 1;
                continue;
            }

            if (locationCallFrame.location === location) {
                if (locationCallFrame.__originalCallFrame) {
                    execToOriginalMap[i] = locationCallFrame.__originalCallFrame.location.id - 1;
                }
                continue;
            }

            if (lineNumber < -1) {
                notResolved++;
                console.warn('Invalid line number for location', i, lineNumber, columnNumber, script?.url, dictionary.locations[i]);
                continue;
            }

            const sourceMap = script?.sourceMap;
            location.__originalLocation = null;
            if (script && sourceMap && lineNumber !== -1 && columnNumber !== -1) {
                const originalPos = getOriginalPositionFor(sourceMap, lineNumber, columnNumber);
                if (originalPos.source) {
                    const scriptIndex = sourceMap.__consumer._absoluteSources.get(originalPos.source);
                    const origCallFrame = locationCallFrame.__originalCallFrame;
                    const originalScript = origCallFrame?.script || scriptsMap.resolveOriginalScript(
                        originalPos.source,
                        sourceMap.sourcesContent?.[scriptIndex] ?? null,
                        script
                    );

                    ensureScriptIsParsed.add(originalScript);
                    locationToResolve.push({
                        i,
                        originalPos,
                        originalScript,
                        origCallFrame
                    });

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

        await prepareScriptSources(ensureScriptIsParsed);
        for (const { i, originalPos, originalScript, origCallFrame } of locationToResolve) {
            const locIndex = dictionary.resolveLocationIndex(
                origCallFrame,
                originalScript,
                -1,
                originalPos.line !== null ? originalPos.line - 1 : -1,
                originalPos.column !== null ? originalPos.column : -1
            );

            // console.log(execToOriginalMap[i] ,'->', locIndex);
            dictionary.locations[i].__originalLocation = locIndex !== -1 ? dictionary.locations[locIndex] : null;
            execToOriginalMap[i] = locIndex;
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
