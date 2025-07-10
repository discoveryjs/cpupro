import type { V8LogProfile } from './types.js';
import type { V8CpuProfileScript } from '../../types.js';

export function normalizeScriptUrl(url: string) {
    // treat <unknown> urls as empty strings which is better for futher processing
    if (url === '<unknown>') {
        url = '';
    } else {
        // FIXME: deno wraps rust paths in brackets, e.g. [ext:cli/worker.rs:191:37]
        // unwrap bracket's content for now, but looks like there should be a better solution
        if (url[0] === '[' && url[url.length - 1] === ']') {
            url = url.slice(1, -1);
        }
    }

    if (url !== '') {
        let protocol = url.match(/^([a-z\-]+):/i)?.[1] || '';

        if (protocol.length === 1 && protocol >= 'A' && protocol <= 'Z') {
            protocol = '';
            url = url.slice(2);
        }

        if (protocol === '' && /^[\\/]/.test(url)) {
            return 'file://' + url.replace(/\\/g, '/');
        }
    }

    return url;
}

export function processScripts(v8logScripts: V8LogProfile['scripts']): (V8CpuProfileScript | null)[] {
    return v8logScripts.map((script) => {
        if (script === null) {
            return null;
        }

        const { id, url, source } = script;

        return {
            id,
            url: normalizeScriptUrl(url),
            source
        };
    });
}
