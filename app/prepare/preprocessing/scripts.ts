import type { CpuProModule, CpuProScript, IProfileScriptsMap, SourceMap, V8CpuProfile, V8CpuProfileScript } from '../types.js';
import type { Dictionary } from '../dictionary.js';
import type { Diagnose } from '../diagnostics.js';
import { getScriptLineBoundaries } from '../misc/script-function-resolution.js';

export class ProfileScriptsMap implements IProfileScriptsMap {
    dict: Dictionary;
    diagnose: Diagnose;
    inputScripts: Set<CpuProScript>;
    sourceMaps: Map<CpuProScript, SourceMap>; // of the input scripts, kept by the input rather than by the scripts
    #scriptById: Map<number | string, CpuProScript>;
    #scriptIdFromString: Map<string, number>;
    #scriptIndexByUrl: Map<string, number[]>;
    #scriptByUrl: Map<string, CpuProScript[]>;

    constructor(
        dict: Dictionary,
        scripts: V8CpuProfileScript[] | null = null,
        diagnose: Diagnose = dict.diagnose
    ) {
        this.dict = dict;
        this.diagnose = diagnose;
        this.inputScripts = new Set();
        this.sourceMaps = new Map();
        this.#scriptById = new Map();
        this.#scriptIdFromString = new Map();
        this.#scriptIndexByUrl = new Map();
        this.#scriptByUrl = this.#createScriptByUrlMap(dict.scripts);

        this.#addScripts(scripts);
    }

    #createScriptByUrlMap(scripts: CpuProScript[]) {
        const scriptByUrlMap = new Map<string, CpuProScript[]>();

        for (const script of scripts) {
            const { url } = script; // FIXME: use script.source
            let scriptByUrl = scriptByUrlMap.get(url || '');

            if (scriptByUrl === undefined) {
                scriptByUrl = [script];
                scriptByUrlMap.set(url || '', scriptByUrl);
            } else {
                scriptByUrl.push(script);
            }
        }

        return scriptByUrlMap;
    }

    #addScripts(scripts: V8CpuProfileScript[] | null) {
        if (!Array.isArray(scripts)) {
            return;
        }

        for (const inputScript of scripts) {
            const {
                id,
                url,
                source,
                sourceMapUrl = null,
                sourceMap = null,
                lineOffset = 0,
                columnOffset = 0
            } = inputScript;
            const script: CpuProScript = this.resolveScript(id, url, source)!;

            this.set(id, script);
            this.inputScripts.add(script);

            script.lineOffset = lineOffset;
            script.columnOffset = columnOffset;
            script.sourceMapUrl = sourceMapUrl ?? null;

            if (sourceMap) {
                script.hasSourceMap = true;
                this.sourceMaps.set(script, sourceMap);
            }
        }
    }

    get size() {
        return this.#scriptById.size;
    }
    get(scriptId: number | string) {
        return this.#scriptById.get(scriptId);
    }
    has(scriptId: number | string) {
        return this.#scriptById.has(scriptId);
    }
    set(scriptId: number | string, script: CpuProScript): this {
        return this.#scriptById.set(scriptId, script) && this;
    }
    entries() {
        return this.#scriptById.entries();
    }

    #getScriptIndexByUrl(scriptId: number, url: string): number {
        let byUrl = this.#scriptIndexByUrl.get(url);
        let seed = -1;

        if (byUrl === undefined) {
            seed = 0;
            byUrl = [scriptId];
            this.#scriptIndexByUrl.set(url, byUrl);
        } else {
            seed = byUrl.indexOf(scriptId);

            if (seed === -1) {
                seed = byUrl.push(scriptId) - 1;
            }
        }

        return seed;
    }

    resolveScript(scriptId: number, url?: string | null, source?: string | null) {
        // return this.dict.resolveScript(scriptId, this, url, source);
        if (scriptId === 0) {
            return null;
        }

        let script = this.get(scriptId);

        if (script === undefined) {
            url ||= '';

            const scriptIndexByUrl = this.#getScriptIndexByUrl(scriptId, url);

            // FIXME: must take into account the source if provided
            let scriptByUrl = this.#scriptByUrl.get(url);
            if (scriptByUrl === undefined) {
                scriptByUrl = [];
                this.#scriptByUrl.set(url, scriptByUrl);
            }

            if (scriptIndexByUrl < scriptByUrl.length) {
                script = scriptByUrl[scriptIndexByUrl];
            } else {
                script = createScript(this.dict.scripts.length + 1, url, source);
                script.module = this.dict.resolveModule(script); // ensure script has module
                scriptByUrl.push(script);
                this.dict.scripts.push(script);
            }

            this.set(scriptId, script);
        }

        return script;
    }

    normalizeScriptId(scriptId: string | number): number {
        // ensure scriptId is a number
        // some tools are generating scriptId as a stringified number
        if (typeof scriptId === 'string') {
            if (/^\d+$/.test(scriptId)) {
                // the simplest case: a stringified number, convert it to a number
                scriptId = Number(scriptId);
            } else {
                // handle cases where scriptId is represented as an URL or a string in the format ":number"
                let numericScriptId = this.#scriptIdFromString.get(scriptId);

                if (numericScriptId === undefined) {
                    this.#scriptIdFromString.set(scriptId, numericScriptId = /^:\d+$/.test(scriptId)
                        ? Number(scriptId.slice(1))
                        : -this.#scriptIdFromString.size - 1
                    );
                }

                scriptId = numericScriptId;
            }
        }

        return scriptId;
    }
}

// Script ids come as numbers or as strings (e.g. in profiles of the DevTools protocol), 0 denotes no script in both forms
export function isNoScriptId(scriptId: string | number) {
    return scriptId === 0 || scriptId === '0';
}

export function scriptFromScriptId(
    scriptId: string | number,
    url: string | null,
    scriptsMap: IProfileScriptsMap
): CpuProScript | null {
    if (isNoScriptId(scriptId)) {
        return null;
    }

    let script = scriptsMap.get(scriptId);

    if (script === undefined) {
        const normScriptId = scriptsMap.normalizeScriptId(scriptId);

        if (normScriptId === 0) {
            return null;
        }

        // resolveScript() registers the script by normScriptId itself, so check before it
        const normScriptIdExists = scriptsMap.has(normScriptId);

        // a profile given with its scripts refers to a script id it doesn't have; a negative id is given
        // to a script known by its url only
        if (normScriptId > 0 && !normScriptIdExists && scriptsMap.inputScripts.size > 0) {
            scriptsMap.diagnose('warn', 'Script not found for id', { scriptId });
        }

        script = scriptsMap.resolveScript(normScriptId, url) as CpuProScript;
        scriptsMap.set(scriptId, script);

        if (normScriptId !== scriptId) {
            if (normScriptIdExists) {
                scriptsMap.diagnose('warn', 'Script already exists for normalized script id', {
                    scriptId: normScriptId,
                    originalScriptId: scriptId
                });
            }

            scriptsMap.set(normScriptId, script);
        }
    }

    return script;
}

export function createScript(id: number, url: string, source: string | null = null): CpuProScript {
    return {
        id,
        url,
        source,
        lineOffset: 0,
        columnOffset: 0,
        sourceMapUrl: null,
        hasSourceMap: false,
        module: null as unknown as CpuProModule,
        callFrames: [],
        functionRanges: null,
        sourceMetrics: null,
        originalFor: null
    };
}

// FIXME: quick & dirty implementation, optimize when possible
// Script offsets of samples from their lines and columns, in the sources of the profile's scripts as the model has
// them, so the offsets are those of the source in which locations are resolved
// PERF: Line boundaries of a script are of the model's script, computed once for all its readers and only for
// scripts of samples; samples take them from a table by script id
export function scriptOffsetsFromLineColumns(
    nodes: V8CpuProfile['nodes'],
    samples: V8CpuProfile['samples'],
    callFrames: V8CpuProfile['_callFrames'],
    scriptsMap: IProfileScriptsMap,
    lines?: V8CpuProfile['lines'],
    columns?: V8CpuProfile['columns']
): number[] | null {
    // Lines and columns of a normalized profile come together, a line and a column per sample
    if (lines === undefined || columns === undefined) {
        return null;
    }

    const scriptLines = new Map<number, {
        lineBoundaries: ReturnType<typeof getScriptLineBoundaries>;
        lineOffset: number;
        columnOffset: number;
    } | null>();

    const nodeById = Object.create(null) as Record<number, V8CpuProfile['nodes'][0]>;
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        nodeById[node.id] = node;
    }

    const result = new Array<number>(samples.length);
    for (let i = 0; i < samples.length; i++) {
        const callFrameRaw = nodeById[samples[i]].callFrame;
        const callFrame = typeof callFrameRaw === 'number' ? callFrames![callFrameRaw] : callFrameRaw;
        const scriptId = Number(callFrame.scriptId);
        let scriptEntry = scriptLines.get(scriptId);
        const line = lines[i];
        let offset = -1;

        if (scriptEntry === undefined) {
            const script = scriptsMap.get(scriptId) ?? null;

            scriptEntry = script !== null
                ? {
                    lineBoundaries: getScriptLineBoundaries(script),
                    lineOffset: script.lineOffset,
                    columnOffset: script.columnOffset
                }
                : null;
            scriptLines.set(scriptId, scriptEntry);
        }

        // Lines and columns of samples are 1-based positions in the document of a script, as positions of call frames
        // are: the first line of the script starts at its column offset
        if (scriptEntry !== null && scriptEntry.lineBoundaries !== null && line) {
            const scriptLine = line - 1 - scriptEntry.lineOffset;
            const column = columns[i] - 1 - (scriptLine === 0 ? scriptEntry.columnOffset : 0);

            offset = scriptEntry.lineBoundaries.offsetOf(scriptLine, column);
        }

        result[i] = offset;
    }

    return result;
}
