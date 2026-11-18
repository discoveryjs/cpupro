import type {
    CpuProCallFrame,
    CpuProCategory,
    CpuProLocation,
    CpuProModule,
    CpuProNode,
    CpuProOwner,
    CpuProPackage,
    CpuProScript
} from './types.js';
import type { Dictionary } from './dictionary.js';
import type { LineTreeDimension, ProfileLine } from './lines/types.js';
import { TreeSource } from './computations/build-trees.js';

export class Usage {
    mapToUsage: Int32Array;
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

export type ProfileCollections = {
    locations: CpuProLocation[];
    callFrames: CpuProCallFrame[];
    scripts: CpuProScript[];
    modules: CpuProModule[];
    packages: CpuProPackage[];
    categories: CpuProCategory[];
    owners: CpuProOwner[];
};

type ProfileDimension = Exclude<keyof ProfileCollections, 'scripts'>;

// The collections of a profile are its own: the entries the dimensions of its breakdowns use over the shared
// dictionary, in the order they are met, and the scripts of their modules. A collection is collected when first
// read, since locations and call frames of a profile number hundreds of thousands on large traces. The getters
// are made outside of the function creating the profile, so they don't keep its context
export function defineProfileCollections<T extends object>(profile: T, lines: ProfileLine[]) {
    const collections: Partial<Record<keyof ProfileCollections, unknown[]>> = {};
    const dimensionCollection = (dimension: ProfileDimension) => ({
        enumerable: true,
        get() {
            return collections[dimension] ??= dimensionEntries(lines, dimension);
        }
    });

    return Object.defineProperties(profile, {
        locations: dimensionCollection('locations'),
        callFrames: dimensionCollection('callFrames'),
        scripts: {
            enumerable: true,
            get(this: ProfileCollections) {
                return collections.scripts ??= scriptsOfModules(this.modules);
            }
        },
        modules: dimensionCollection('modules'),
        packages: dimensionCollection('packages'),
        categories: dimensionCollection('categories'),
        owners: dimensionCollection('owners')
    }) as T & ProfileCollections;
}

function dimensionEntries(lines: ProfileLine[], dimension: ProfileDimension) {
    const entries = new Set<CpuProNode>();

    for (let i = 0; i < lines.length; i++) {
        const breakdowns = lines[i].breakdowns;

        for (let j = 0; j < breakdowns.length; j++) {
            const breakdownDimension: LineTreeDimension<CpuProNode> | null = breakdowns[j][dimension];

            if (breakdownDimension === null) {
                continue;
            }

            const dictionary = breakdownDimension.tree.dictionary;

            for (let k = 0; k < dictionary.length; k++) {
                entries.add(dictionary[k]);
            }
        }
    }

    return [...entries];
}

function scriptsOfModules(modules: CpuProModule[]) {
    const scripts = new Set<CpuProScript>();

    for (let i = 0; i < modules.length; i++) {
        const script = modules[i].script;

        if (script !== null) {
            scripts.add(script);
        }
    }

    return [...scripts];
}
