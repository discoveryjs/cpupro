import { CpuProScript, CpuProScriptFunction, V8CpuProfileFunction, V8CpuProfileScript } from './types.js';

function normalizeUrl(url: string) {
    let protocol = (url.match(/^([a-z\-]+):/i) || [])[1] || '';

    if (protocol.length === 1 && /[A-Z]/.test(protocol)) {
        protocol = '';
        url = url.slice(2);
    }

    if (protocol === '') {
        return 'file://' + url.replace(/\\/g, '/');
    }

    return url;
}

export function processScripts(
    inputScripts: V8CpuProfileScript[] = [],
    inputFunctions: V8CpuProfileFunction[] = []
) {
    const scripts: CpuProScript[] = [];
    const scriptFunctions: CpuProScriptFunction[] = [];

    for (const script of inputScripts || []) {
        scripts.push({
            ...script,
            url: normalizeUrl(script.url || ''),
            functions: []
        });
    }

    for (const fn of inputFunctions || []) {
        const script = fn.script !== null ? scripts[fn.script] || null : null;
        const newFn: CpuProScriptFunction = {
            ...fn,
            script,
            loc: script && fn.line !== -1 && fn.column !== -1
                ? `${script.url}:${fn.line}:${fn.column}`
                : null
        };

        if (newFn.script !== null) {
            newFn.script.functions.push(newFn);
        }

        scriptFunctions.push(newFn);
    }

    return {
        scripts,
        scriptFunctions
    };
}
