import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const JSX_REGEX = /\.[mc]?[tj]sx($|[\?\#\|])/;
const TS_REGEX = /\.[mc]?ts($|[\?\#\|])/;

// A file extension that selects the dialect the script is parsed as, by the script's url
function dialectExtension(url) {
    if (JSX_REGEX.test(url)) {
        return '.tsx';
    }

    if (TS_REGEX.test(url)) {
        return '.ts';
    }

    return '.js';
}

// Writes the sources of the parsed scripts of every profile, generated and original, to a directory,
// one file per script with an extension of its dialect, for scripts/compare-function-ranges.mjs
export default function dumpScriptSources(model, { options }) {
    if (!options.dir) {
        throw new Error('The dir option is required');
    }

    const written = new Set();
    let generated = 0;
    let original = 0;
    let size = 0;

    mkdirSync(options.dir, { recursive: true });

    for (let i = 0; i < model.data.profiles.length; i++) {
        const scripts = model.data.profiles[i].scripts;

        for (let j = 0; j < scripts.length; j++) {
            const script = scripts[j];

            if (written.has(script) || typeof script.source !== 'string' || script.sourceMetrics === null) {
                continue;
            }

            written.add(script);
            writeFileSync(join(options.dir, written.size + dialectExtension(script.url || '')), script.source);
            size += script.source.length;

            if (script.originalFor) {
                original++;
            } else {
                generated++;
            }
        }
    }

    return {
        dir: options.dir,
        generated,
        original,
        size
    };
}
