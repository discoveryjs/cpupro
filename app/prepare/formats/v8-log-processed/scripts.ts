import type { V8LogScripts } from './types.js';
import type { V8CpuProfileScript } from '../../types.js';

export function processScripts(scripts: V8LogScripts): (V8CpuProfileScript | null)[] {
    return scripts.map((script) => {
        if (script === null) {
            return null;
        }

        const { id, url, source } = script;

        return {
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
        };
    });
}
