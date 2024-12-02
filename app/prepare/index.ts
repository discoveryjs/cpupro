import { convertParentIntoChildrenIfNeeded, isCPUProfile, unrollHeadToNodesIfNeeded, unwrapSamplesIfNeeded } from './formats/cpuprofile.js';
import { extractFromDevToolsEnhancedTraces, isDevToolsEnhancedTraces } from './formats/chromium-devtools-enhanced-traces.js';
import { extractFromChromiumPerformanceProfile, isChromiumPerformanceProfile } from './formats/chromium-performance-profile.js';
import { convertV8LogIntoCpuProfile, isV8LogProfile } from './formats/v8-log-processed.js';
import type { V8CpuProfile, V8CpuProfileCpuproExtensions, V8CpuProfileSet } from './types.js';
import { V8LogProfile } from './formats/v8-log-processed/types.js';

export const supportedFormats = [
    '* [V8 CPU profile](https://nodejs.org/docs/latest/api/cli.html#--cpu-prof) (.cpuprofile)',
    '* [V8 log](https://v8.dev/docs/profile) preprocessed with [--preprocess](https://v8.dev/docs/profile#web-ui-for---prof) (.json)',
    '* [Chromium Performance Profile](https://developer.chrome.com/docs/devtools/performance/reference#save) (.json)',
    '* [Edge Enhanced Performance Traces](https://learn.microsoft.com/en-us/microsoft-edge/devtools-guide-chromium/experimental-features/share-traces) (.devtools)'
];
export const supportedFormatsText = supportedFormats
    .map(line => line.replace(/\[(.+?)\]\(.*?\)/g, '$1'));

const futureReleases = false;

// function isCPUProfileMerge(data) {
//     return data && Array.isArray(data.nodes) && Array.isArray(data.profiles);
// }

// type InputProfile =
//     | DevToolsEnchandedTraceEventsProfile
//     | ChromiumTraceEventsProfile
//     | V8LogProfile
//     | V8CpuProfile;
// type Input =
//     | InputProfile
//     | InputProfile[]
//     | {
//         profiles: InputProfile[]
//     };
type InputProfiles = {
    indexToView?: number;
    profiles: (V8LogProfile | V8CpuProfile)[];
}

export function extractAndValidate(data: unknown, rejectData: (reason: string, view?: unknown) => void) {
    let extensions: V8CpuProfileCpuproExtensions = {};
    let inputProfiles: InputProfiles | null = null;

    data = data || {};

    if (isDevToolsEnhancedTraces(data)) {
        const { traceEvents, runtime, scripts, executionContexts } = extractFromDevToolsEnhancedTraces(data);

        data = traceEvents;
        extensions = {
            _runtime: runtime,
            _scripts: scripts,
            _executionContexts: executionContexts
        };
    }

    // see https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/preview#heading=h.lc5airzennvk
    if (isChromiumPerformanceProfile(data)) {
        inputProfiles = extractFromChromiumPerformanceProfile(data);
    } else if (Array.isArray(data)) {
        if (isV8LogProfile(data[0]) || isCPUProfile(data[0])) {
            inputProfiles = {
                profiles: data
            };
        }
    } else if (isV8LogProfile(data) || isCPUProfile(data)) {
        inputProfiles = {
            profiles: [data]
        };
    } else {
        rejectData('Unknown format');
        throw new Error('Unknown format');
    }

    const result: V8CpuProfileSet = {
        indexToView: inputProfiles?.indexToView || 0,
        profiles: []
    };
    for (let profile of inputProfiles?.profiles || []) {
        if (isV8LogProfile(profile)) {
            result.profiles.push(convertV8LogIntoCpuProfile(profile));
        } else if (isCPUProfile(profile)) {
            profile = unrollHeadToNodesIfNeeded(profile);
            profile = unwrapSamplesIfNeeded(profile);
            convertParentIntoChildrenIfNeeded(profile);
            Object.assign(profile, extensions);
            result.profiles.push(profile);
        } else {
            rejectData('Bad format', {
                view: 'md', source: [
                    'CPUpro supports the following formats:',
                    ...supportedFormats
                ]
            });

            throw new Error('Bad format');
        }
    }

    if (result.profiles.length === 0) {
        rejectData('CPU profiles not found');
    }

    if (!futureReleases) {
        // return only the first profile until multi-profile mode is fully implemented
        return {
            ...result,
            profiles: result.profiles.slice(0, 1)
        };
    }

    return result;
}
