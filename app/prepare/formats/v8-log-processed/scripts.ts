import type { V8LogProfile } from './types.js';
import type { V8CpuProfileScript } from '../../types.js';

export function processScripts(v8log: V8LogProfile) {
    const scripts: V8CpuProfileScript[] = [];

    for (const { id, url, source } of v8log.scripts.filter(Boolean)) {
        scripts.push({
            id,
            // treat <unknown> urls as empty strings which is better for futher processing
            url: url === '<unknown>'
                ? ''
                // FIXME: deno wraps rust paths in brackets, e.g. [ext:cli/worker.rs:191:37]
                // unwrap bracket's content for now, but looks like there should be a better solution
                : url[0] === '[' && url[url.length - 1] === ']'
                    ? url.slice(1, -1)
                    : url,
            source
        });
    }

    return scripts;
}
