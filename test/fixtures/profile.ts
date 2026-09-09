import { SourceMapGenerator } from 'source-map-js';
import { Dictionary } from '../../app/prepare/dictionary.js';
import { OriginalScriptsMap, ProfileScriptsMap } from '../../app/prepare/preprocessing/scripts.js';
import { createProfile } from '../../app/prepare/profile.mjs';
import type { V8CpuProfile } from '../../app/prepare/types.js';
import { noopWorkHandler } from '../../app/prepare/misc/work.js';

export type ProfileFixtureOptions = {
    noSourceMap?: boolean;
    fallback?: boolean;
    cpuOnly?: boolean;
    locationsOnly?: boolean;
    stackOnly?: boolean;
    mapping?: number[];
    contexts?: number[];
};

export async function createProfileFixture(options: ProfileFixtureOptions = {}) {
    const dictionary = new Dictionary();
    const originalScripts = new OriginalScriptsMap(dictionary);
    const generator = new SourceMapGenerator({ file: 'compiled.js' });
    for (const column of [0, 10, 20]) {
        generator.addMapping({
            generated: { line: 1, column },
            original: { line: column / 10 + 1, column: 0 },
            source: 'original.js'
        });
    }
    const scripts = [{ id: 1, url: '/compiled.js', source: '', sourceMap: options.noSourceMap ? null : JSON.parse(generator.toString()) }];
    const scriptsMap = new ProfileScriptsMap(dictionary, originalScripts, scripts);
    for (const column of [10, 20]) {
        dictionary.resolveLocationIndex(null, scriptsMap.get(1), column, 0, column);
    }
    const data: V8CpuProfile = {
        startTime: 0,
        endTime: 40,
        nodes: [
            { id: 1, callFrame: { scriptId: 0, url: '', functionName: '(root)', lineNumber: -1, columnNumber: -1 }, children: [2, 3] },
            { id: 2, callFrame: { scriptId: 1, url: '/compiled.js', functionName: 'first', lineNumber: 0, columnNumber: 0 } },
            { id: 3, callFrame: { scriptId: 1, url: '/compiled.js', functionName: 'second', lineNumber: 0, columnNumber: 20 } }
        ],
        samples: [2, 3, 2],
        timeDeltas: [10, 10, 10],
        _samplePositions: options.fallback ? undefined : [10, 20, 10],
        _scripts: scripts
    };
    if (!options.cpuOnly) {
        Object.assign(data, {
            _cpuproAllocationMapping: options.locationsOnly ? undefined : options.mapping || [1, 3, 4],
            _cpuproAllocationIds: [1, 2, 3, 4],
            _cpuproAllocationSizes: [16, 32, 48, 64]
        });
        if (!options.stackOnly) {
            Object.assign(data, {
                _cpuproAllocationScriptIds: [1, 1, 1, 0],
                _cpuproAllocationLocations: [10, 20, 10, -1],
                _cpuproAllocationContextInfo: options.contexts || [0, 0, 0, 0],
                _cpuproAllocationVmStateNames: { 1: 'gc', 2: 'parser' }
            });
        }
    }

    const profile = await createProfile(data, { dictionary, originalScripts, work: noopWorkHandler });
    return { profile, dictionary, scriptsMap };
}
