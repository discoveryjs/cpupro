import type { Dictionary } from '../dictionary.js';
import type { CpuProScript, CpuProScriptFunction, IScriptMapper, V8CpuProfileScript } from '../types.js';

export function mapScripts(
    dict: Dictionary,
    scripts?: V8CpuProfileScript[] | null
) {
    const map = new ScriptMapper(dict);

    if (Array.isArray(scripts)) {
        for (const { id, url, source } of scripts) {
            map.set(id, dict.resolveScript(id, map, url, source) as CpuProScript);
        }
    }

    return map;
}

export class ScriptMapper implements IScriptMapper {
    dict: Dictionary;
    scriptById: Map<number | string, CpuProScript>;
    scriptIdFromString: Map<string, number>;
    byUrl: Map<string, number[]>;

    constructor(dict: Dictionary) {
        this.dict = dict;
        this.scriptById = new Map();
        this.scriptIdFromString = new Map();
        this.byUrl = new Map();
    }

    get(scriptId: number | string) {
        return this.scriptById.get(scriptId);
    }
    has(scriptId: number | string) {
        return this.scriptById.has(scriptId);
    }
    set(scriptId: number | string, script: CpuProScript) {
        this.scriptById.set(scriptId, script);
        return this;
    }
    entries() {
        return this.scriptById.entries();
    }

    getScriptIndexByUrl(scriptId: number, url: string): number {
        let byUrl = this.byUrl.get(url);
        let seed = -1;

        if (byUrl === undefined) {
            seed = 0;
            byUrl = [scriptId];
            this.byUrl.set(url, byUrl);
        } else {
            seed = byUrl.indexOf(scriptId);

            if (seed === -1) {
                seed = byUrl.push(scriptId) - 1;
            }
        }

        return seed;
    }

    resolveScript(scriptId: number, url?: string | null, script?: string | null) {
        return this.dict.resolveScript(scriptId, this, url, script);
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
                let numericScriptId = this.scriptIdFromString.get(scriptId);

                if (numericScriptId === undefined) {
                    this.scriptIdFromString.set(scriptId, numericScriptId = /^:\d+$/.test(scriptId)
                        ? Number(scriptId.slice(1))
                        : -this.scriptIdFromString.size - 1
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
    mapper: IScriptMapper
): CpuProScript | null {
    if (scriptId === 0 || scriptId === '0') {
        return null;
    }

    let script = mapper.get(scriptId);

    if (script === undefined) {
        const normScriptId = mapper.normalizeScriptId(scriptId);

        if (normScriptId === 0) {
            return null;
        }

        script = mapper.resolveScript(normScriptId, url) as CpuProScript;
        mapper.set(scriptId, script);
        mapper.set(normScriptId, script);
    }

    return script;
}

export function createScript(id: number, url: string, source: string | null): CpuProScript {
    return {
        id,
        url,
        source,
        module: null,
        callFrames: [],
        functions: []
    };
}

export function createProfileScript() {}

export function processScripts(
    inputScripts: V8CpuProfileScript[] = []
) {
    const scripts: CpuProScript[] = [];
    const scriptById = new Map<number, CpuProScript>();

    // process scripts
    for (const { id, url, source } of inputScripts) {
        const script = createScript(id, url, source);

        scripts.push(script);
        scriptById.set(script.id, script);
    }

    return {
        scripts,
        scriptById
    };
}

export const scriptFunctionsSorting = (a: CpuProScriptFunction, b: CpuProScriptFunction) =>
    (a.start - b.start) || (b.end - a.end) || (a.id - b.id);

export function sortScriptFunctions(scripts: CpuProScript[]) {
    for (const script of scripts) {
        if (script.functions.length > 1) {
            script.functions.sort(scriptFunctionsSorting);
        }
    }
}
