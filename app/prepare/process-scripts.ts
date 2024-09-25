import { vmFunctionStateTierHotness, vmFunctionStateTiers } from './const.js';
import {
    CpuProScript,
    CpuProScriptFunction,
    V8CpuProfileScriptFunction,
    V8CpuProfileScript,
    CpuProModule,
    CpuProFunction,
    V8FunctionStateTier,
    CpuProCallFrame
} from './types.js';

export const scriptFunctionsSorting = (a, b) => (a.start - b.start) || (b.end - a.end) || (a.id - b.id);

export function locFromLineColumn(line: number, column: number) {
    return line !== -1 && column !== -1
        ? `:${line}:${column}`
        : null;
}

export function processScripts(
    inputScripts: V8CpuProfileScript[] = [],
    inputFunctions: V8CpuProfileScriptFunction[] = [],
    startTime: number = 0
) {
    const scripts: CpuProScript[] = [];
    const scriptFunctions: CpuProScriptFunction[] = [];
    const functionById = new Map<number, CpuProScriptFunction>();
    const scriptById = new Map<number, CpuProScript>();

    // process scripts
    for (const inputScript of inputScripts || []) {
        const script: CpuProScript = {
            ...inputScript,
            url: inputScript.url,
            module: null,
            compilation: null,
            functions: []
        };

        scripts.push(script);
        scriptById.set(script.id, script);
    }

    // process script's functions
    for (const inputFn of inputFunctions || []) {
        const script = inputFn.script !== null ? scriptById.get(inputFn.script) || null : null;
        const states = inputFn.states;
        let topTier: V8FunctionStateTier = 'Unknown';
        const fn: CpuProScriptFunction = {
            id: inputFn.id,
            name: inputFn.name,
            script,
            line: inputFn.line,
            column: inputFn.column,
            start: inputFn.start,
            end: inputFn.end,
            loc: locFromLineColumn(inputFn.line, inputFn.column),
            function: null,
            topTier,
            hotness: 'cold',
            states: new Array(states.length),
            inlinedInto: null
        };

        scriptFunctions.push(fn);
        functionById.set(fn.id, fn);

        // attach function to a script
        if (script !== null) {
            if (fn.start === 0 && fn.end === script.source.length) {
                script.compilation = fn;
            } else {
                script.functions.push(fn);
            }
        }

        // process function's states
        for (let i = 0, topTierWeight = 0; i < states.length; i++) {
            const state = states[i];
            const tier = state.tier;
            const tierWeight = vmFunctionStateTiers.indexOf(tier);

            fn.states[i] = {
                ...state,
                tm: state.tm - startTime,
                duration: i !== states.length - 1
                    ? states[i + 1].tm - state.tm
                    : 0,
                scriptFunction: fn
            };

            if (tierWeight > topTierWeight) {
                topTierWeight = tierWeight;
                topTier = tier;
            }
        }

        fn.topTier = topTier;
        fn.hotness = vmFunctionStateTierHotness[topTier];
    }

    // finalize scripts
    sortScriptFunctions(scripts);

    // process script function states
    // for (const fn of scriptFunctions) {
    //     for (let i = 0; i < fn.states.length; i++) {
    //         const state = fn.states[i];

    //         if (state.fns?.length > 0) {
    //             for (let j = 0; j < state.fns.length; j++) {
    //                 const inlineFnId = state.fns[j];
    //                 const inlinedFn = functionById.get(inlineFnId);

    //                 state.fns[j] = inlinedFn;

    //                 if (!inlinedFn) {
    //                     console.error('Inlined function is not resolved, function:', fn, `, state (#${i}):`, state, `, reference (#${j}):`, inlineFnId);
    //                 } else if (!inlinedFn.inlinedInto) {
    //                     inlinedFn.inlinedInto = [fn];
    //                 } else if (!inlinedFn.inlinedInto.includes(fn)) {
    //                     inlinedFn.inlinedInto.push(fn);
    //                 }
    //             }
    //         }
    //     }
    // }

    return {
        scripts,
        scriptById,
        scriptFunctions
    };
}

function mapScriptFunctionToFunction(fn: CpuProScriptFunction, locToFn: Map<string, CpuProFunction>) {
    const moduleFn = fn.loc !== null ? locToFn.get(fn.loc) : undefined;

    if (moduleFn !== undefined) {
        fn.function = moduleFn;

        if (!fn.name && moduleFn.name) {
            fn.name = moduleFn.name;
        }
    }
}

// link script functions with call tree functions
export function linkStriptToModule(
    scripts: CpuProScript[],
    moduleByScriptId: Map<number, CpuProModule> = new Map()
) {
    for (const script of scripts) {
        const module = moduleByScriptId.get(script.id);

        if (module === undefined) {
            continue;
        }

        const locToFn = new Map<string, CpuProFunction>();

        script.module = module;

        for (const moduleFn of module.functions) {
            const loc = moduleFn.loc;

            if (loc !== null) {
                locToFn.set(loc, moduleFn);
            }
        }

        for (const fn of script.functions) {
            mapScriptFunctionToFunction(fn, locToFn);
        }

        if (script.compilation !== null) {
            mapScriptFunctionToFunction(script.compilation, locToFn);
        }
    }
}

export function scriptsFromCallFrames(
    callFrames: CpuProCallFrame[],
    scripts: CpuProScript[],
    scriptById: Map<number, CpuProScript>,
    scriptFunctions: CpuProScriptFunction[] = []
) {
    if (scriptById.size > 0) {
        return;
    }

    for (const callFrame of callFrames) {
        const { scriptId, url, functionName, lineNumber, columnNumber } = callFrame;

        if (scriptId !== 0) {
            let script = scriptById.get(scriptId);

            if (script === undefined) {
                script = {
                    id: scriptId,
                    url: url || '',
                    module: null,
                    source: '',
                    compilation: null,
                    functions: []
                };

                scripts.push(script);
                scriptById.set(scriptId, script);
            }

            const scriptFunction: CpuProScriptFunction = {
                id: scriptFunctions.length + 1,
                name: functionName,
                script,
                line: lineNumber,
                column: columnNumber,
                start: -1,
                end: -1,
                loc: locFromLineColumn(lineNumber, columnNumber),
                function: null,
                topTier: 'Unknown',
                hotness: 'cold',
                states: [],
                inlinedInto: null
            };

            scriptFunctions.push(scriptFunction);
            script.functions.push(scriptFunction);
            callFrame.url = script.url;
        }
    }

    scripts.sort((a, b) => a.id - b.id);
    sortScriptFunctions(scripts);
}

export function sortScriptFunctions(scripts: CpuProScript[]) {
    for (const script of scripts) {
        if (script.functions.length > 1) {
            script.functions.sort(scriptFunctionsSorting);
        }
    }
}
