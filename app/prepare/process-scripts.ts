import {
    CpuProScript,
    CpuProScriptFunction,
    V8CpuProfileScriptFunction,
    V8CpuProfileScript,
    CpuProModule,
    CpuProFunction
} from './types.js';

function normalizeUrl(url: string) {
    let protocol = url.match(/^([a-z\-]+):/i)?.[1] || '';

    if (protocol.length === 1 && /[A-Z]/.test(protocol)) {
        protocol = '';
        url = url.slice(2);
    }

    if (protocol === '' && /^[\\/]/.test(url)) {
        return 'file://' + url.replace(/\\/g, '/');
    }

    return url;
}

function mapScriptFunctionToFunction(fn: CpuProScriptFunction, locToFn: Map<string, CpuProFunction>) {
    const moduleFn = locToFn.get(`:${fn.line}:${fn.column}`);

    if (moduleFn !== undefined) {
        fn.function = moduleFn;

        if (!fn.name && moduleFn.name) {
            fn.name = moduleFn.name;
        }
    }
}

export function processScripts(
    inputScripts: V8CpuProfileScript[] = [],
    inputFunctions: V8CpuProfileScriptFunction[] = [],
    moduleByScriptId: Map<number, CpuProModule>
) {
    const scripts: CpuProScript[] = [];
    const scriptFunctions: CpuProScriptFunction[] = [];
    const functionById = new Map<number, CpuProScriptFunction>();
    const scriptById = new Map<number, CpuProScript>();

    // process scripts
    for (const inputScript of inputScripts || []) {
        const script: CpuProScript = {
            ...inputScript,
            url: normalizeUrl(inputScript.url || ''),
            module: moduleByScriptId.get(inputScript.id) || null,
            compilation: null,
            functions: []
        };

        scripts.push(script);
        scriptById.set(script.id, script);
    }

    // process script's functions
    for (const inputFn of inputFunctions || []) {
        const script = inputFn.script !== null ? scriptById.get(inputFn.script) || null : null;
        const loc = script !== null && inputFn.line !== -1 && inputFn.column !== -1
            ? `:${inputFn.line}:${inputFn.column}`
            : null;
        const fn: CpuProScriptFunction = {
            ...inputFn,
            script,
            loc,
            function: null,
            inlinedInto: null,
            states: inputFn.states.map((state, idx, array) => ({
                ...state,
                duration: idx !== array.length - 1
                    ? array[idx + 1].tm - state.tm
                    : 0
            }))
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
    }

    // link script functions with call tree functions
    for (const script of scripts) {
        if (script.module === null) {
            continue;
        }

        const locToFn = new Map<string, CpuProFunction>();

        for (const moduleFn of script.module.functions) {
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
        scriptFunctions
    };
}
