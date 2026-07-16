import type { CpuProModule, CpuProScript, IProfileScriptsMap, V8CpuProfile, V8CpuProfileScript } from '../types.js';
import type { Dictionary } from '../dictionary.js';
import { createLineBoundaries } from '../misc/line-boundaries.js';
import { utils } from '@discoveryjs/discovery';

export class OriginalScriptsMap {
    #scriptsByUrl: Map<string, CpuProScript[]>;
    #nextScriptId: number = -1;

    constructor(public dict: Dictionary) {
        this.#scriptsByUrl = new Map();
    }

    resolveScript(url: string, source: string | null, from: CpuProScript | null = null): CpuProScript {
        const scripts = this.#scriptsByUrl.get(url);
        let script = scripts?.find(s => s.source === source && s.originalFor === from);

        if (!script) {
            script = createScript(this.#nextScriptId--, url, source);
            script.module = this.dict.resolveModule(script);
            script.originalFor = from;

            if (scripts) {
                scripts.push(script);
            } else {
                this.#scriptsByUrl.set(url, [script]);
            }
        }

        return script;
    }
}

export class ProfileScriptsMap implements IProfileScriptsMap {
    dict: Dictionary;
    #scriptById: Map<number | string, CpuProScript>;
    #scriptIdFromString: Map<string, number>;
    #scriptIndexByUrl: Map<string, number[]>;
    #scriptByUrl: Map<string, CpuProScript[]>;
    #originalScripts: OriginalScriptsMap;

    constructor(
        dict: Dictionary,
        originalScripts: OriginalScriptsMap,
        scripts?: V8CpuProfileScript[] | null
    ) {
        this.dict = dict;
        this.#scriptById = new Map();
        this.#scriptIdFromString = new Map();
        this.#scriptIndexByUrl = new Map();
        this.#scriptByUrl = this.#createScriptByUrlMap(dict.scripts);
        this.#originalScripts = originalScripts || new OriginalScriptsMap(dict);

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

    #addScripts(scripts?: V8CpuProfileScript[] | null) {
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

            script.lineOffset = lineOffset;
            script.columnOffset = columnOffset;
            script.sourceMapUrl = sourceMapUrl ?? null;
            script.sourceMap = sourceMap ?? null;
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

    getScriptsById(ids: Set<number | string> | (number | string)[]) {
        const scripts: CpuProScript[] = [];

        for (const id of ids) {
            const script = this.#scriptById.get(id);

            if (script) {
                scripts.push(script);
            } else if (id !== 0 && id !== '0') {
                console.warn('Script not found for id', id);
            }
        }

        return scripts;
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

    resolveOriginalScript(url: string, source: string | null, from: CpuProScript | null = null): CpuProScript {
        const script = this.#originalScripts.resolveScript(url, source, from);

        if (!this.#scriptById.has(script.id)) {
            this.#scriptById.set(script.id, script);
            this.dict.scripts.push(script);
        }

        return script;
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

export function scriptFromScriptId(
    scriptId: string | number,
    url: string | null,
    scriptsMap: IProfileScriptsMap
): CpuProScript | null {
    if (scriptId === 0 || scriptId === '0') {
        return null;
    }

    let script = scriptsMap.get(scriptId);

    if (script === undefined) {
        const normScriptId = scriptsMap.normalizeScriptId(scriptId);

        if (normScriptId === 0) {
            return null;
        }

        script = scriptsMap.resolveScript(normScriptId, url) as CpuProScript;
        scriptsMap.set(scriptId, script);

        if (normScriptId !== scriptId) {
            if (scriptsMap.has(normScriptId)) {
                console.warn('Script already exists for normalized scriptId', normScriptId, 'for original scriptId', scriptId);
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
        sourceMap: null,
        module: null as unknown as CpuProModule,
        callFrames: [],
        functionRanges: null,
        originalFor: null
    };
}

// FIXME: quick & dirty implementation, optimize when possible
export function scriptOffsetsFromLineColumns(
    nodes: V8CpuProfile['nodes'],
    samples: V8CpuProfile['samples'],
    callFrames: V8CpuProfile['_callFrames'],
    scripts?: V8CpuProfile['_scripts'],
    lines?: V8CpuProfile['lines'],
    columns?: V8CpuProfile['columns']
): number[] | null {
    if (!Array.isArray(scripts)) {
        return null;
    }

    if (!Array.isArray(lines) || !Array.isArray(columns) || lines.length !== columns.length || lines.length === 0) {
        return null;
    }

    const scriptLineBoundaries = Object.create(null) as Record<number, {
        lineBoundaries: ReturnType<typeof createLineBoundaries>;
        lineOffset: number;
        columnOffset: number;
    }>;
    for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i];
        if (script && script.source) {
            scriptLineBoundaries[script.id] = {
                lineBoundaries: createLineBoundaries(script.source),
                lineOffset: script.lineOffset ?? 0,
                columnOffset: script.columnOffset ?? 0
            };
        }
    }

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
        const scriptEntry = scriptLineBoundaries[scriptId];
        const line = lines[i];
        let offset = -1;

        if (scriptEntry && line) {
            const column = columns[i];
            offset = scriptEntry.lineBoundaries.getOffset(
                line - scriptEntry.lineOffset,
                column - (line === scriptEntry.lineOffset ? scriptEntry.columnOffset : 0)
            );
        }

        result[i] = offset;
    }

    return result;
}

// Extract all script ids used in the profile, in all known places
// (nodes, callFrames, allocation events)
export function collectProfileUsedScriptIds(data: V8CpuProfile) {
    const {
        nodes,
        _callFrames,
        _cpuproAllocationScriptIds
    } = data;
    const usedScriptIds = new Set<number | string>();

    for (let i = 0; i < nodes.length; i++) {
        const callFrame = nodes[i].callFrame;

        // when callFrame is a number, it is an index into _callFrames array,
        // otherwise it is a callFrame object
        if (typeof callFrame !== 'number') {
            usedScriptIds.add(callFrame.scriptId);
        }
    }

    if (Array.isArray(_callFrames)) {
        for (let i = 0; i < _callFrames.length; i++) {
            usedScriptIds.add(_callFrames[i].scriptId);
        }
    }

    // utils.isArray() is used here since it treats both Array and TypedArray as arrays,
    // which is useful for _cpuproAllocationScriptIds that can be either
    if (utils.isArray(_cpuproAllocationScriptIds)) {
        for (let i = 0; i < _cpuproAllocationScriptIds.length; i++) {
            usedScriptIds.add(_cpuproAllocationScriptIds[i]);
        }
    }

    return usedScriptIds;
}
