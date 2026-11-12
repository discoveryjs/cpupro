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
// Dictionary locations are append-only, so the mapping is extended by the locations added since the previous call.
export class SourceMapping {
    #dictionary: Dictionary;
    #ownership: Ownership | null;
    #diagnose: Diagnose;
    #sourceMaps: Map<CpuProScript, ScriptSourceMap | null>;
    #originalScriptsByUrl: Map<string, CpuProScript[]>;
    #nextOriginalScriptId: number = -1;
    #unregisteredScripts: CpuProScript[];
    #parsing: Promise<void>[];

    // original positions of looked up locations to be resolved into original locations
    #lookedUpLocationsCount: number = 0;
    #pendingLocations: number[];
    #pendingScripts: CpuProScript[];
    #pendingLines: number[];
    #pendingColumns: number[];

    #originalLocations: Int32Array; // location index -> original location index, the same index when no original
    #mappedLocationsCount: number = 0;

    constructor(dictionary: Dictionary, ownership: Ownership | null = null, diagnose: Diagnose = dictionary.diagnose) {
        this.#dictionary = dictionary;
        this.#ownership = ownership;
        this.#diagnose = diagnose;
        this.#sourceMaps = new Map();
        this.#originalScriptsByUrl = new Map();
        this.#unregisteredScripts = [];
        this.#parsing = [];
        this.#pendingLocations = [];
        this.#pendingScripts = [];
        this.#pendingLines = [];
        this.#pendingColumns = [];
        this.#originalLocations = new Int32Array(0);
    }

    get hasSourceMaps() {
        return this.#sourceMaps.size > 0;
    }

    // Looks up original positions of the locations added since the previous call and starts parsing
    // of their original scripts, so the parsing can overlap with other work until mapLocations()
    prepareLocations() {
        const { locations } = this.#dictionary;
        const originalScripts = new Set<CpuProScript>();

        for (let i = this.#lookedUpLocationsCount; i < locations.length; i++) {
            const location = locations[i];
            const { script, callFrame } = location;

            if (script === null || script.sourceMap === null) {
                continue;
            }

            const sourceMap = this.#getSourceMap(script);

            if (sourceMap === null) {
                continue;
            }

            // a location without a position is somewhere in its function, e.g. a call site of a caller
            // unknown to a profile, so the original function is looked up by the function's start
            const position = location === callFrame.noLocLocation
                ? callFrame.location
                : location;
            const { decoded } = sourceMap;
            const segment = decoded.findSegment(position.line, position.column);
            const sourceIndex = segment !== -1 ? decoded.sourceIndexes[segment] : -1;

            if (sourceIndex !== -1 && sourceIndex < decoded.sources.length) {
                const originalScript = this.#getOriginalScript(script, sourceMap, sourceIndex);

                originalScripts.add(originalScript);
                this.#pendingLocations.push(i);
                this.#pendingScripts.push(originalScript);
                this.#pendingLines.push(decoded.originalLines[segment]);
                this.#pendingColumns.push(decoded.originalColumns[segment]);
            }
        }

        this.#lookedUpLocationsCount = locations.length;

        // function ranges of original scripts are required to resolve call frames of original locations
        if (originalScripts.size > 0) {
            this.#parsing.push(prepareScriptSources(originalScripts, this.#diagnose));
        }
    }

    // Returns a location index -> original location index map for all the dictionary locations
    async mapLocations() {
        const dictionary = this.#dictionary;
        const { locations } = dictionary;

        this.prepareLocations();

        // registering happens here rather than on lookup, so the order of dictionary scripts and modules
        // doesn't depend on when the locations were looked up
        for (const script of this.#unregisteredScripts) {
            script.module = dictionary.resolveModule(script);

            // ownership files are paths of original sources
            if (this.#ownership !== null) {
                const area = this.#ownership.areas[this.#ownership.files[script.url]?.[0] ?? -1];

                if (area !== undefined) {
                    script.module.owner = dictionary.resolveOwner(area);
                }
            }

            dictionary.scripts.push(script);
        }

        await Promise.all(this.#parsing);

        const pendingLocations = this.#pendingLocations;
        const resolvedLocations = new Int32Array(pendingLocations.length);

        for (let i = 0; i < pendingLocations.length; i++) {
            const location = locations[pendingLocations[i]];
            const script = this.#pendingScripts[i];
            const line = this.#pendingLines[i];
            const column = this.#pendingColumns[i];
            // a position belongs to the innermost function whose declaration contains it, including the function's name;
            // a script without source or not parsed has no functions
            const functionRange = getFunctionAtSourceLineColumn(script, line, column);
            const callFrame = functionRange !== null
                ? dictionary.resolveFunctionRangeCallFrame(script, functionRange)
                : dictionary.callFrames[dictionary.resolveScriptCallFrameIndex(script)];

            if (location.callFrame.noLocLocation === location) {
                resolvedLocations[i] = dictionary.resolveLocationIndex(callFrame);
            } else if (location.callFrame.location === location) {
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

        for (let i = 0; i < pendingLocations.length; i++) {
            this.#originalLocations[pendingLocations[i]] = resolvedLocations[i];
        }

        this.#mappedLocationsCount = locations.length;
        this.#unregisteredScripts = [];
        this.#parsing = [];
        this.#pendingLocations = [];
        this.#pendingScripts = [];
        this.#pendingLines = [];
        this.#pendingColumns = [];

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
                script = createScript(this.#nextOriginalScriptId--, url, source);
                script.originalFor = generatedScript;
                scriptsByUrl.push(script);
                this.#unregisteredScripts.push(script);
            }

            sourceMap.originalScripts[sourceIndex] = script;
        }

        return script;
    }
}
