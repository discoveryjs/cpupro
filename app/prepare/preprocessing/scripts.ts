import type { Dictionary } from '../dictionary.js';
import type { CpuProModule, CpuProScript, IProfileScriptsMap, V8CpuProfileScript } from '../types.js';
// import { SourceMapConsumer } from 'source-map-js';

export class ProfileScriptsMap implements IProfileScriptsMap {
    dict: Dictionary;
    #scriptById: Map<number | string, CpuProScript>;
    #scriptIdFromString: Map<string, number>;
    $scriptIndexByUrl: Map<string, number[]>;
    #scriptByUrl: Map<string, CpuProScript[]>;
    #originalScriptByUrl: Map<string, CpuProScript>;

    constructor(dict: Dictionary, scripts?: V8CpuProfileScript[] | null) {
        this.dict = dict;
        this.#scriptById = new Map();
        this.#scriptIdFromString = new Map();
        this.$scriptIndexByUrl = new Map();
        this.#scriptByUrl = this.#createScriptByUrlMap(dict.scripts);
        this.#originalScriptByUrl = new Map();

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
            // if (sourceMap && sourceMap.sourcesContent) {
            //     try {
            //         const sourceMapConsumer = new SourceMapConsumer(sourceMap);

            //         script._sourceMap = sourceMapConsumer;
            //         script._originalScripts = Object.create(null);
            //         for (let i = 0; i < sourceMap.sourcesContent.length; i++) {
            //             const smc = sourceMap.sourcesContent[i];
            //             const smUrl = sourceMap.sourceRoot
            //                 ? new URL(sourceMap.sources[i], sourceMap.sourceRoot || '').toString()
            //                 : sourceMap.sources[i];
            //             script._originalScripts[smUrl] = createScript(-1, smUrl, smc);
            //         }
            //     } catch (e) {
            //         console.warn('Failed to parse source map for script', url, e);
            //     }
            // }
        }
    }

    get(scriptId: number | string) {
        return this.#scriptById.get(scriptId);
    }
    has(scriptId: number | string) {
        return this.#scriptById.has(scriptId);
    }
    set(scriptId: number | string, script: CpuProScript) {
        this.#scriptById.set(scriptId, script);
        return this;
    }
    entries() {
        return this.#scriptById.entries();
    }

    #getScriptIndexByUrl(scriptId: number, url: string): number {
        let byUrl = this.$scriptIndexByUrl.get(url);
        let seed = -1;

        if (byUrl === undefined) {
            seed = 0;
            byUrl = [scriptId];
            this.$scriptIndexByUrl.set(url, byUrl);
        } else {
            seed = byUrl.indexOf(scriptId);

            if (seed === -1) {
                seed = byUrl.push(scriptId) - 1;
            }
        }

        return seed;
    }

    resolveOriginalScript(url: string, source: string | null, from: CpuProScript | null = null): CpuProScript {
        let script = this.#originalScriptByUrl.get(url);

        if (!script) {
            script = createScript(-this.#originalScriptByUrl.size - 1, url, source);
            script.module = this.dict.resolveModule(script);
            script.originalFor = from;
            this.#originalScriptByUrl.set(url, script);
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
        scriptsMap.set(normScriptId, script);
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
        originalFor: null
    };
}
