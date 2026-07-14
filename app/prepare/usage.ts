import type { CpuProCallFrame, CpuProCategory, CpuProLocation, CpuProModule, CpuProOwner, CpuProPackage, CpuProScript } from './types.js';
import type { Dictionary } from './dictionary.js';
import { TreeSource } from './computations/build-trees.js';

export class Usage {
    locations: CpuProLocation[] | null;
    callFrames: CpuProCallFrame[];
    scripts: CpuProScript[];
    modules: CpuProModule[];
    packages: CpuProPackage[];
    categories: CpuProCategory[];
    owners: CpuProOwner[];

    locationToCallFrame: Uint32Array | null;
    callFrameToModule: Uint32Array;
    moduleToScript: Uint32Array;
    moduleToPackage: Uint32Array;
    packageToCategory: Uint32Array;
    moduleToOwner: Uint32Array;

    constructor(
        dict: Dictionary,
        treeSource: TreeSource<CpuProLocation> | TreeSource<CpuProCallFrame>
    ) {
        if (treeSource.dictionary === dict.locations) {
            const usedLocations = new Int32Array(dict.locations.length).fill(-1);
            const locations: CpuProLocation[] = [];

            for (let i = 0; i < treeSource.nodes.length; i++) {
                const dictIndex = treeSource.nodes[i];

                if (usedLocations[dictIndex] === -1) {
                    usedLocations[dictIndex] = locations.push(treeSource.dictionary[dictIndex]) - 1;
                }
            }

            this.mapToUsage = usedLocations;
            this.locations = locations;
            [this.callFrames, this.locationToCallFrame] = getUsed(dict.callFrames, this.locations, dict.locationToCallFrame);
        } else if (treeSource.dictionary === dict.callFrames) {
            const usedCallFrames = new Int32Array(dict.callFrames.length).fill(-1);
            const callFrames: CpuProCallFrame[] = [];

            for (let i = 0; i < treeSource.nodes.length; i++) {
                const dictIndex = treeSource.nodes[i];

                if (usedCallFrames[dictIndex] === -1) {
                    usedCallFrames[dictIndex] = callFrames.push(treeSource.dictionary[dictIndex]) - 1;
                }
            }

            this.mapToUsage = usedCallFrames;
            this.locations = null;
            this.locationToCallFrame = null;
            this.callFrames = callFrames;
        } else {
            throw new Error('Unsupported tree source dictionary');
        }

        [this.modules, this.callFrameToModule] = getUsed(dict.modules, this.callFrames, dict.callFrameToModule);
        [this.scripts, this.moduleToScript] = getUsed(dict.scripts, this.modules, dict.moduleToScript);
        [this.packages, this.moduleToPackage] = getUsed(dict.packages, this.modules, dict.moduleToPackage);
        [this.categories, this.packageToCategory] = getUsed(dict.categories, this.packages, dict.packageToCategory);
        [this.owners, this.moduleToOwner] = getUsed(dict.owners, this.modules, dict.moduleToOwner);
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
    const usedDictToSourceIndex = new Uint32Array(usedDictionary.length);
    const used = new Map<T, number>();

    for (let i = 0; i < usedDictionary.length; i++) {
        const entry = fn(usedDictionary[i])!;
        let entryIndex = used.get(entry);

        if (entryIndex === undefined) {
            entryIndex = used.size;
            used.set(entry, entryIndex);
        }

        usedDictToSourceIndex[i] = entryIndex;
    }

    return [
        [...used.keys()],
        usedDictToSourceIndex
    ];
}
