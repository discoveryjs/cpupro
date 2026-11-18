import type { Dictionary } from '../dictionary.js';
import type { Diagnose } from '../diagnostics.js';
import type { Ownership } from '../formats/types.js';
import type { CpuProScript } from '../types.js';
import type { SampledTreeSet } from '../computations/sampled-tree-set.js';
import { SourceMapIndex } from '../misc/source-map.js';
import {
    getFunctionAtSourceLineColumn,
    prepareScriptSources,
    releaseScriptLineBoundaries
} from '../misc/script-function-resolution.js';
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
        this.#registerOriginalScripts();

        const pendingLocations = this.#pendingLocations;

        // lookups start parsing early, by the time a tree is mapped the parsing is mostly done
        await Promise.all(this.#parsing);

        for (let i = 0; i < pendingLocations.length; i++) {
            const locationIndex = pendingLocations[i];
            const location = locations[locationIndex];
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
                this.#originalLocations[locationIndex] = dictionary.resolveLocationIndex(callFrame);
            } else if (location.callFrame.location === location) {
                // the start of a generated function denotes the start of its original function
                this.#originalLocations[locationIndex] = callFrame.location.id - 1;
            } else {
                this.#originalLocations[locationIndex] = dictionary.resolveLocationIndex(
                    callFrame,
                    script,
                    -1,
                    line,
                    column
                );
            }
        }

        this.#parsing = [];
        this.#pendingLocations = [];
        this.#pendingScripts = [];
        this.#pendingLines = [];
        this.#pendingColumns = [];

        // original locations are added to the dictionary
        this.#growOriginalLocations();

        return this.#originalLocations.subarray(0, locations.length);
    }

    // Once the profiles of the session are mapped, a script with a source map takes the original scripts of all
    // sources of the map, the sources no location maps to included, and the line boundaries of original scripts
    // have no reader: original locations keep their offsets, and views take lines of sources from the sources.
    // PERF: The original scripts are created here rather than on reading the originals of a script, as creating
    // an original script resolves its module by the dictionary: keeping the dictionary for that kept 83 MB more
    // after loading a large trace, while creating the rest of its originals (9K of 36K) takes 14–19 ms
    completeSession() {
        const { scripts } = this.#dictionary;
        const scriptCount = scripts.length;

        for (let i = 0; i < scriptCount; i++) {
            const script = scripts[i];

            if (script.sourceMap === null) {
                continue;
            }

            const sourceMap = this.#getSourceMap(script);

            if (sourceMap === null) {
                continue;
            }

            const originals = new Array<CpuProScript>(sourceMap.originalScripts.length);

            for (let j = 0; j < originals.length; j++) {
                originals[j] = this.#getOriginalScript(script, sourceMap, j);
            }

            script.originals = originals;
        }

        this.#registerOriginalScripts();

        for (const scriptsOfUrl of this.#originalScriptsByUrl.values()) {
            releaseScriptLineBoundaries(scriptsOfUrl);
        }
    }

    #registerOriginalScripts() {
        const dictionary = this.#dictionary;
        const ownership = this.#ownership;
        const scripts = this.#unregisteredScripts;

        for (let i = 0; i < scripts.length; i++) {
            const script = scripts[i];

            script.module = dictionary.resolveModule(script);

            // ownership files are paths of original sources, the first area of a file owns it
            if (ownership !== null) {
                const fileAreas = ownership.files[script.url];
                const area = fileAreas !== undefined
                    ? ownership.areas[fileAreas[0]]
                    : undefined;

                if (area !== undefined) {
                    script.module.owner = dictionary.resolveOwner(area);
                }
            }

            dictionary.scripts.push(script);
        }

        this.#unregisteredScripts = [];
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
            sourceMap = null;

            try {
                const index = new SourceMapIndex(script.sourceMap!);

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
            const { sources, sourcesContent } = sourceMap.index;
            const url = sources[sourceIndex];
            const source = sourcesContent[sourceIndex] ?? null;
            let scriptsByUrl = this.#originalScriptsByUrl.get(url);

            if (scriptsByUrl === undefined) {
                scriptsByUrl = [];
                this.#originalScriptsByUrl.set(url, scriptsByUrl);
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
