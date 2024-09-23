import type { V8LogScripts } from './types.js';
import type { V8CpuProfileScript } from '../../types.js';

export function processScripts(scripts: V8LogScripts) {
    const processedScripts: V8CpuProfileScript[] = [];

    for (const { id, url, source } of scripts.filter(script => script !== null)) {
        processedScripts.push({
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

    return processedScripts;
}
