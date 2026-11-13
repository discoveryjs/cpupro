import type { Dictionary } from '../dictionary.js';
import type { Diagnose } from '../diagnostics.js';
import type { Ownership } from '../formats/types.js';
import type { CpuProScript, SourceMap } from '../types.js';
import type { SampledTreeSet } from '../computations/sampled-tree-set.js';
import { SourceMapIndex } from '../misc/source-map.js';
import { getFunctionAtSourceLineColumn, prepareScriptSources } from '../misc/script-function-resolution.js';
import { createScript } from './scripts.js';

const NOT_LOOKED_UP = -1;

type ScriptSourceMap = {
    index: SourceMapIndex;
    originalScripts: (CpuProScript | null)[]; // by source index
};

// Owns the original scripts of a session and the mapping of dictionary locations in source-mapped scripts
// to locations in their original scripts. An original location belongs to the original function containing it,
// regardless of the generated function, which may contain inlined or moved code of other original functions.
// Only locations of the trees being mapped are mapped, as no other reader of the mapping exists.
export class SourceMapping {
    #dictionary: Dictionary;
    #ownership: Ownership | null;
    #diagnose: Diagnose;
    #inputSourceMaps: Map<CpuProScript, SourceMap>; // given until a script's source map is indexed
    #sourceMaps: Map<CpuProScript, ScriptSourceMap | null>;
    #originalScriptsByUrl: Map<string, CpuProScript[]>;
    #nextOriginalScriptId: number = -1;
    #unregisteredScripts: CpuProScript[];

    // original positions of looked up locations to be resolved into original locations, resolvable once parsing
    // of their original scripts is done; a lookup starts parsing of the original scripts it finds
    #parsing: Promise<void>[]; // by lookup
    #pendingLocations: number[];
    #pendingScripts: CpuProScript[];
    #pendingLines: number[];
    #pendingColumns: number[];

    // location index -> original location index, the same index when there's no original location,
    // NOT_LOOKED_UP for a location that no mapped tree has
    #originalLocations: Int32Array;

    constructor(dictionary: Dictionary, ownership: Ownership | null = null, diagnose: Diagnose = dictionary.diagnose) {
        this.#dictionary = dictionary;
        this.#ownership = ownership;
        this.#diagnose = diagnose;
        this.#inputSourceMaps = new Map();
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

    // Source maps of scripts given with a profile, which come from its input; a script keeps only that it has one
    addSourceMaps(sourceMaps: Map<CpuProScript, SourceMap>) {
        for (const [script, sourceMap] of sourceMaps) {
            if (!this.#sourceMaps.has(script)) {
                this.#inputSourceMaps.set(script, sourceMap);
            }
        }
    }

    get hasSourceMaps() {
        return this.#sourceMaps.size > 0;
    }

    // Looks up original positions of the locations of a tree that weren't looked up yet and starts parsing
    // of their original scripts, so the parsing can overlap with other work until the tree is mapped
    prepareLocations(source: SampledTreeSet['source']) {
        const { locations } = this.#dictionary;

        if (source.dictionary !== locations) {
            return;
        }

        const { nodes } = source;
        const originalScripts = new Set<CpuProScript>();

        this.#growOriginalLocations();

        for (let i = 0; i < nodes.length; i++) {
            const locationIndex = nodes[i];

            if (this.#originalLocations[locationIndex] !== NOT_LOOKED_UP) {
                continue;
            }

            const location = locations[locationIndex];
            const { script, callFrame } = location;

            this.#originalLocations[locationIndex] = locationIndex;

            if (script === null || !script.hasSourceMap) {
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
            const originalPosition = sourceMap.index.findOriginalPosition(position.line, position.column);

            if (originalPosition !== null) {
                const originalScript = this.#getOriginalScript(script, sourceMap, originalPosition.source);

                originalScripts.add(originalScript);
                this.#pendingLocations.push(locationIndex);
                this.#pendingScripts.push(originalScript);
                this.#pendingLines.push(originalPosition.line);
                this.#pendingColumns.push(originalPosition.column);
            }
        }

        // function ranges of original scripts are required to resolve call frames of original locations
        if (originalScripts.size > 0) {
            this.#parsing.push(prepareScriptSources(originalScripts, this.#diagnose));
        }
    }

    // Returns a location index -> original location index map for the locations of a tree,
    // null when the tree isn't a tree of locations
    async mapLocations(source: SampledTreeSet['source']) {
        const dictionary = this.#dictionary;
        const { locations } = dictionary;

        if (source.dictionary !== locations) {
            return null;
        }

        this.prepareLocations(source);

        // registering happens here rather than on lookup, so the order of dictionary scripts and modules
        // doesn't depend on when the locations were looked up
        for (let i = 0; i < this.#unregisteredScripts.length; i++) {
            const script = this.#unregisteredScripts[i];

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

        const pendingLocations = this.#pendingLocations;

        // lookups start parsing early, by the time a tree is mapped the parsing is mostly done
        await Promise.all(this.#parsing);

        for (let i = 0; i < pendingLocations.length; i++) {
            const location = locations[pendingLocations[i]];
            const script = this.#pendingScripts[i];
            const line = this.#pendingLines[i];
            const column = this.#pendingColumns[i];
            // a position belongs to the innermost function whose declaration contains it,
            // including the function's name; a script without source or not parsed has no functions
            const functionRange = getFunctionAtSourceLineColumn(script, line, column);
            const callFrame = functionRange !== null
                ? dictionary.resolveFunctionRangeCallFrame(script, functionRange)
                : dictionary.callFrames[dictionary.resolveScriptCallFrameIndex(script)];

            if (location.callFrame.noLocLocation === location) {
                this.#originalLocations[pendingLocations[i]] = dictionary.resolveLocationIndex(callFrame);
            } else if (location.callFrame.location === location) {
                // the start of a generated function denotes the start of its original function
                this.#originalLocations[pendingLocations[i]] = callFrame.location.id - 1;
            } else {
                this.#originalLocations[pendingLocations[i]] = dictionary.resolveLocationIndex(
                    callFrame,
                    script,
                    -1,
                    line,
                    column
                );
            }
        }

        this.#unregisteredScripts = [];
        this.#parsing = [];
        this.#pendingLocations = [];
        this.#pendingScripts = [];
        this.#pendingLines = [];
        this.#pendingColumns = [];

        // original locations are added to the dictionary
        this.#growOriginalLocations();

        return this.#originalLocations.subarray(0, locations.length);
    }

    #growOriginalLocations() {
        const locationCount = this.#dictionary.locations.length;

        if (this.#originalLocations.length < locationCount) {
            const originalLocations = new Int32Array(Math.max(locationCount, 2 * this.#originalLocations.length));

            originalLocations.set(this.#originalLocations);
            originalLocations.fill(NOT_LOOKED_UP, this.#originalLocations.length);
            this.#originalLocations = originalLocations;
        }
    }

    #getSourceMap(script: CpuProScript) {
        let sourceMap = this.#sourceMaps.get(script);

        if (sourceMap === undefined) {
            const inputSourceMap = this.#inputSourceMaps.get(script);

            if (inputSourceMap === undefined) {
                return null;
            }

            sourceMap = null;
            this.#inputSourceMaps.delete(script);

            try {
                const index = new SourceMapIndex(inputSourceMap);

                sourceMap = {
                    index,
                    originalScripts: new Array(index.sources.length).fill(null)
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
            const url = sourceMap.index.sources[sourceIndex];
            const source = sourceMap.index.sourcesContent[sourceIndex] ?? null;
            let scriptsByUrl = this.#originalScriptsByUrl.get(url);

            if (scriptsByUrl === undefined) {
                this.#originalScriptsByUrl.set(url, scriptsByUrl = []);
            }

            // a source map may list the same source several times
            const isSameScript = (script: CpuProScript) =>
                script.originalFor === generatedScript && script.source === source;

            script = scriptsByUrl.find(isSameScript) ?? null;

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
