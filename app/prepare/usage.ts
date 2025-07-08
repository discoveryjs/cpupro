import type { CpuProCallFrame, CpuProCategory, CpuProModule, CpuProPackage, CpuProScript } from './types.js';
import type { Dictionary } from './dictionary.js';

export class Usage {
    callFrames: CpuProCallFrame[];
    scripts: CpuProScript[];
    modules: CpuProModule[];
    packages: CpuProPackage[];
    categories: CpuProCategory[];

    callFrameToModule: Uint32Array;
    moduleToScript: Uint32Array;
    moduleToPackage: Uint32Array;
    packageToCategory: Uint32Array;

    constructor(
        dict: Dictionary,
        callFrameByNodeIndex: Uint32Array
    ) {
        const usedCallFrame = new Uint8Array(dict.callFrames.length);

        for (let i = 0; i < callFrameByNodeIndex.length; i++) {
            usedCallFrame[callFrameByNodeIndex[i]] = 1;
        }

        for (let i = 0; i < usedCallFrame.length; i++) {
            if (usedCallFrame[i] === 0) {
                const { kind } = dict.callFrames[i];
                usedCallFrame[i] = Number(kind === 'function' || kind === 'script' || kind === 'regexp');
            }
        }

        this.callFrames = dict.callFrames.filter((_, idx) => usedCallFrame[idx]);
        [this.modules, this.callFrameToModule] = getUsed(dict.modules, this.callFrames, dict.callFrameToModule);
        [this.scripts, this.moduleToScript] = getUsed(dict.scripts, this.modules, dict.moduleToScript);
        [this.packages, this.moduleToPackage] = getUsed(dict.packages, this.modules, dict.moduleToPackage);
        [this.categories, this.packageToCategory] = getUsed(dict.categories, this.packages, dict.packageToCategory);
    }
}

function getUsed<T, S>(
    sourceDictionary: T[],
    usedDictionary: S[],
    fn: (callFrame: S) => T | null
): [
    dict: T[],
    dictToSourceIndex: Uint32Array
] {
    const used = new Set(usedDictionary.map(fn).filter(Boolean));
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

    return [
        usedDict,
        usedDictToSourceIndex
    ];
}
