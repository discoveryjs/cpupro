import type { Diagnose } from '../../app/prepare/diagnostics.js';
import { Dictionary } from '../../app/prepare/dictionary.js';
import { parseScriptSourceRanges } from '../../app/prepare/misc/parse-script-source-ranges.js';
import { computeScriptSourceMetrics } from '../../app/prepare/misc/source-text-metrics.js';
import { ProfileScriptsMap } from '../../app/prepare/preprocessing/scripts.js';
import type { CpuProScript } from '../../app/prepare/types.js';

// Sets function ranges and source metrics of a script, as source preparation does
export function parseScriptFixture(script: CpuProScript) {
    const parsed = parseScriptSourceRanges(script.source!, script.url, true);

    script.functionRanges = parsed.ranges;
    script.sourceMetrics = computeScriptSourceMetrics(script.source, parsed.ranges);
}

// A scripts map with a parsed script 7
export function createScriptFixture(source: string, diagnose?: Diagnose) {
    const dictionary = new Dictionary(diagnose);
    const scripts = new ProfileScriptsMap(dictionary, [{ id: 7, url: 'fixture.js', source }], diagnose);
    const script = scripts.get(7)!;

    parseScriptFixture(script);

    return { dictionary, scripts, script };
}
