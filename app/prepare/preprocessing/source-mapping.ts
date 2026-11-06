import type { Dictionary } from '../dictionary.js';
import type { Diagnose } from '../diagnostics.js';
import type { Ownership } from '../formats/types.js';
import type { CpuProScript } from '../types.js';
import { DecodedSourceMap } from '../misc/source-map.js';
import { getFunctionAtSourceLineColumn, prepareScriptSources } from '../misc/script-function-resolution.js';
import { createScript } from './scripts.js';

type ScriptSourceMap = {
    decoded: DecodedSourceMap;
    originalScripts: (CpuProScript | null)[]; // by source index
};

// Owns the original scripts of a session and the mapping of dictionary locations in source-mapped scripts
// to locations in their original scripts. An original location belongs to the original function containing it,
// regardless of the generated function, which may contain inlined or moved code of other original functions.
// Dictionary locations are append-only, so every call maps only the locations added since the previous one.
export class SourceMapping {
    #dictionary: Dictionary;
    #ownership: Ownership | null;
    #diagnose: Diagnose;
    #sourceMaps: Map<CpuProScript, ScriptSourceMap | null>;
    #originalScriptsByUrl: Map<string, CpuProScript[]>;
    #nextOriginalScriptId: number = -1;
    #originalLocations: Int32Array; // location index -> original location index, the same index when no original
    #mappedLocationsCount: number = 0;

    constructor(dictionary: Dictionary, ownership: Ownership | null = null, diagnose: Diagnose = dictionary.diagnose) {
        this.#dictionary = dictionary;
        this.#ownership = ownership;
        this.#diagnose = diagnose;
        this.#sourceMaps = new Map();
        this.#originalScriptsByUrl = new Map();
        this.#originalLocations = new Int32Array(0);
    }

    get hasSourceMaps() {
        return this.#sourceMaps.size > 0;
    }

    async mapLocations() {
        const dictionary = this.#dictionary;
        const { locations } = dictionary;
        const mappedLocations: number[] = [];
        const originalScripts: CpuProScript[] = [];
        const originalLines: number[] = [];
        const originalColumns: number[] = [];

        for (let i = this.#mappedLocationsCount; i < locations.length; i++) {
            const { script, line, column } = locations[i];

            if (script === null || script.sourceMap === null) {
                continue;
            }

            const sourceMap = this.#getSourceMap(script);

            if (sourceMap === null || line === -1 || column === -1) {
                continue;
            }

            const { decoded } = sourceMap;
            const segment = decoded.findSegment(line, column);
            const sourceIndex = segment !== -1 ? decoded.sourceIndexes[segment] : -1;

            if (sourceIndex !== -1 && sourceIndex < decoded.sources.length) {
                mappedLocations.push(i);
                originalScripts.push(this.#getOriginalScript(script, sourceMap, sourceIndex));
                originalLines.push(decoded.originalLines[segment]);
                originalColumns.push(decoded.originalColumns[segment]);
            }
        }

        // function ranges of original scripts are required to resolve call frames of original locations
        await prepareScriptSources(new Set(originalScripts), this.#diagnose);

        const resolvedLocations = new Int32Array(mappedLocations.length);

        for (let i = 0; i < mappedLocations.length; i++) {
            const location = locations[mappedLocations[i]];
            const script = originalScripts[i];
            const line = originalLines[i];
            const column = originalColumns[i];
            // a position belongs to the innermost function whose declaration contains it, including the function's name;
            // a script without source or not parsed has no functions
            const functionRange = getFunctionAtSourceLineColumn(script, line, column);
            const callFrame = functionRange !== null
                ? dictionary.resolveFunctionRangeCallFrame(script, functionRange)
                : dictionary.callFrames[dictionary.resolveScriptCallFrameIndex(script)];

            if (location.callFrame.location === location) {
                // the start of a generated function denotes the start of its original function
                resolvedLocations[i] = callFrame.location.id - 1;
            } else {
                resolvedLocations[i] = dictionary.resolveLocationIndex(callFrame, script, -1, line, column);
            }
        }

        // original locations are added to the dictionary as well, they map to themselves
        if (this.#originalLocations.length < locations.length) {
            const newOriginalLocations = new Int32Array(Math.max(locations.length, 2 * this.#originalLocations.length));

            newOriginalLocations.set(this.#originalLocations);
            this.#originalLocations = newOriginalLocations;
        }

        for (let i = this.#mappedLocationsCount; i < locations.length; i++) {
            this.#originalLocations[i] = i;
        }

        for (let i = 0; i < mappedLocations.length; i++) {
            this.#originalLocations[mappedLocations[i]] = resolvedLocations[i];
        }

        this.#mappedLocationsCount = locations.length;

        return this.#originalLocations.subarray(0, locations.length);
    }

    #getSourceMap(script: CpuProScript) {
        let sourceMap = this.#sourceMaps.get(script);

        if (sourceMap === undefined) {
            sourceMap = null;

            try {
                const decoded = new DecodedSourceMap(script.sourceMap!);

                sourceMap = {
                    decoded,
                    originalScripts: new Array(decoded.sources.length).fill(null)
                };
            } catch (error) {
                this.#diagnose('error', 'Failed to decode a source map', {
                    scriptId: script.id,
                    url: script.url,
                    error: String(error)
                });
            }

            this.#sourceMaps.set(script, sourceMap);
        }

        return sourceMap;
    }

    #getOriginalScript(generatedScript: CpuProScript, sourceMap: ScriptSourceMap, sourceIndex: number) {
        let script = sourceMap.originalScripts[sourceIndex];

        if (script === null) {
            const url = sourceMap.decoded.sources[sourceIndex];
            const source = sourceMap.decoded.sourcesContent[sourceIndex] ?? null;
            let scriptsByUrl = this.#originalScriptsByUrl.get(url);

            if (scriptsByUrl === undefined) {
                this.#originalScriptsByUrl.set(url, scriptsByUrl = []);
            }

            // a source map may list the same source several times
            script = scriptsByUrl.find(script => script.originalFor === generatedScript && script.source === source) ?? null;

            if (script === null) {
                script = this.#createOriginalScript(generatedScript, url, source);
                scriptsByUrl.push(script);
            }

            sourceMap.originalScripts[sourceIndex] = script;
        }

        return script;
    }

    #createOriginalScript(generatedScript: CpuProScript, url: string, source: string | null) {
        const dictionary = this.#dictionary;
        const script = createScript(this.#nextOriginalScriptId--, url, source);

        script.originalFor = generatedScript;
        script.module = dictionary.resolveModule(script);

        // ownership files are paths of original sources
        if (this.#ownership !== null) {
            const area = this.#ownership.areas[this.#ownership.files[url]?.[0] ?? -1];

            if (area !== undefined) {
                script.module.owner = dictionary.resolveOwner(area);
            }
        }

        dictionary.scripts.push(script);

        return script;
    }
}
