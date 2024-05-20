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

    // process scripts
    for (const script of inputScripts || []) {
        scripts.push({
            ...script,
            url: normalizeUrl(script.url || ''),
            module: moduleByScriptId.get(script.id) || null,
            compilation: null,
            functions: []
        });
    }

    // process script's functions
    for (const fn of inputFunctions || []) {
        const script = fn.script !== null ? scripts[fn.script] || null : null;
        const loc = script && fn.line !== -1 && fn.column !== -1
            ? `:${fn.line}:${fn.column}`
            : null;
        const newFn: CpuProScriptFunction = {
            ...fn,
            script,
            loc,
            function: null,
            inlinedInto: null,
            states: fn.states.map((state, idx, array) => ({
                ...state,
                duration: idx !== array.length - 1
                    ? array[idx + 1].tm - state.tm
                    : 0
            }))
        };

        scriptFunctions.push(newFn);
        functionById.set(newFn.id, newFn);

        // attach function to a script
        if (script !== null) {
            if (newFn.start === 0 && newFn.end === script.source.length) {
                script.compilation = newFn;
            } else {
                script.functions.push(newFn);
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
