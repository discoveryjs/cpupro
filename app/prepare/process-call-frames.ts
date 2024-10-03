import { Dictionary } from './dictionary.js';
import { locFromLineColumn } from './process-functions.js';
import { sortScriptFunctions } from './process-scripts.js';
import type {
    CpuProCallFrame,
    CpuProCategory,
    CpuProPackage,
    CpuProModule,
    CpuProFunction,
    CpuProScript,
    V8CpuProfileExecutionContext,
    CpuProScriptFunction
} from './types.js';

export function createCpuProFrame(
    id: number,
    scriptId: number,
    url: string | null,
    functionName: string,
    lineNumber: number,
    columnNumber: number
): CpuProCallFrame {
    return {
        id,
        scriptId,
        url,
        functionName,
        lineNumber,
        columnNumber,
        // these field will be populated on call frames processing step
        category: null as unknown as CpuProCategory,
        package: null as unknown as CpuProPackage,
        module: null as unknown as CpuProModule,
        function: null as unknown as CpuProFunction,
        script: null as unknown as CpuProScript
    };
}

export function scriptsAndFunctionsFromCallFrames(
    callFrames: CpuProCallFrame[],
    scripts: CpuProScript[],
    scriptById: Map<number, CpuProScript>,
    scriptFunctions: CpuProScriptFunction[] = []
) {
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
                start: -1,
                end: -1,
                line: lineNumber,
                column: columnNumber,
                loc: locFromLineColumn(lineNumber, columnNumber)
            };

            scriptFunctions.push(scriptFunction);
            script.functions.push(scriptFunction);

            callFrame.url = script.url;
        }
    }

    sortScriptFunctions(scripts);

    return scriptFunctions;
}

export function processCallFrames(
    dict: Dictionary,
    scripts: CpuProScript[],
    scriptById: Map<number, CpuProScript>,
    scriptFunctions: CpuProScriptFunction[],
    executionContexts: V8CpuProfileExecutionContext[] = []
) {
    // main part
    for (const { origin, name } of executionContexts) {
        dict.setPackageNameForOrigin(new URL(origin).host, name);
    }

    if (scriptFunctions.length === 0) {
        scriptsAndFunctionsFromCallFrames(dict.callFrames, scripts, scriptById, scriptFunctions);
    }

    for (const script of scripts) {
        script.module = dict.resolveModuleByScript(script.id, script.url);
    }

    for (const callFrame of dict.callFrames) {
        const { scriptId, functionName, lineNumber, columnNumber } = callFrame;
        const fn = dict.createFunction(scriptId, functionName, lineNumber, columnNumber);

        dict.functions.push(fn);

        callFrame.script = scriptById.get(scriptId) || null;
        callFrame.module = fn.module;
        callFrame.package = fn.package;
        callFrame.category = fn.category;
        callFrame.function = fn;
    }

    return {
        categories: dict.categories,
        packages: dict.packages,
        modules: dict.modules,
        functions: dict.functions
    };
}
