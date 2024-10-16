import type { Dictionary } from './dictionary.js';
import type { CpuProCallFrame, CpuProCategory, CpuProModule, CpuProPackage, CpuProProfileFunction, CpuProScript } from './types.js';

export class Usage {
    callFrames: CpuProCallFrame[];
    scripts: CpuProScript[];
    modules: CpuProModule[];
    packages: CpuProPackage[];
    categories: CpuProCategory[];

    constructor(
        dict: Dictionary,
        callFrameByNodeIndex: Uint32Array,
        scriptFunctions: CpuProProfileFunction[]
    ) {
        const usedCallFrame = new Uint8Array(dict.callFrames.length);

        for (let i = 0; i < callFrameByNodeIndex.length; i++) {
            usedCallFrame[callFrameByNodeIndex[i]] = 1;
        }

        for (let i = 0; i < scriptFunctions.length; i++) {
            usedCallFrame[scriptFunctions[i].callFrame.id - 1] = 1;
        }

        this.callFrames = dict.callFrames.filter((_, idx) => usedCallFrame[idx]);
        this.scripts = getUsed(dict.scripts, this.callFrames, callFrame => callFrame.script).usedDict;
        this.modules = getUsed(dict.modules, this.callFrames, callFrame => callFrame.module).usedDict;
        this.packages = getUsed(dict.packages, this.callFrames, callFrame => callFrame.package).usedDict;
        this.categories = getUsed(dict.categories, this.callFrames, callFrame => callFrame.category).usedDict;
    }
}

function getUsed<T>(sourceDictionary: T[], callFrames: CpuProCallFrame[], fn: (callFrame: CpuProCallFrame) => T | null) {
    const used = new Set(callFrames.map(fn));
    const usedDictToSourceIndex = new Uint32Array(used.size);
    const usedDict: T[] = new Array(used.size);

    for (let i = 0, k = 0; i < sourceDictionary.length; i++) {
        const entry = sourceDictionary[i];

        if (used.has(entry)) {
            usedDictToSourceIndex[k] = i;
            usedDict[k] = entry;
            k++;
        }
    }

    return {
        usedDictToSourceIndex,
        usedDict
    };
}
