import { convertParentIntoChildrenIfNeeded, isCPUProfile, normalizeCpuProfile, unrollHeadToNodesIfNeeded, unwrapSamplesIfNeeded } from './formats/cpuprofile.js';
import { extractFromDevToolsEnhancedTraces, isDevToolsEnhancedTraces } from './formats/chromium-devtools-enhanced-traces.js';
import { extractFromChromiumPerformanceProfile, isChromiumPerformanceProfile } from './formats/chromium-performance-profile.js';
import { convertV8LogIntoCpuProfile, isV8LogProfile } from './formats/v8-log-processed.js';
import type { V8CpuProfile, V8CpuProfileCpuproExtensions } from './types.js';
import { FEATURE_MULTI_PROFILES } from './const.js';
import { UniformProfile, UniformProfilingDataset, UniformProfilingSession } from './formats/types.js';
import { V8LogProfile } from './formats/v8-log-processed/types.js';

export const supportedFormats = [
    '* [V8 log](https://v8.dev/docs/profile) (.log)',
    '* [V8 log preprocessed](https://v8.dev/docs/profile#web-ui-for---prof) with --preprocess (.json)',
    '* [V8 CPU profile](https://nodejs.org/docs/latest/api/cli.html#--cpu-prof) (.cpuprofile)',
    '* [Chromium Performance Profile](https://developer.chrome.com/docs/devtools/performance/reference#save) (.json)',
    '* [Edge Enhanced Performance Traces](https://learn.microsoft.com/en-us/microsoft-edge/devtools-guide-chromium/experimental-features/share-traces) (.devtools)'
];
export const supportedFormatsText = supportedFormats
    .map(line => line.replace(/\[(.+?)\]\(.*?\)/g, '$1'));

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

function createProfilingDataset(sessions: UniformProfilingSession[] = []): UniformProfilingDataset {
    return {
        sessions
    };
}

function createProfilingSession(profiles: UniformProfile[] = []): UniformProfilingSession {
    return {
        name: null,
        runtime: null,
        startTime: null,
        source: null,
        dataOrigin: null,
        setupId: null,
        buildId: null,
        scenarioId: null,
        processes: [],
        threads: [],
        profiles
    };
}

function processProfiles(
    inputProfiles: (V8LogProfile | V8CpuProfile)[],
    extensions: V8CpuProfileCpuproExtensions = {},
    rejectData: (reason: string, view?: unknown) => void = () => {}
): UniformProfile[] {
    const result: V8CpuProfile[] = [];

    for (let profile of inputProfiles) {
        if (isV8LogProfile(profile)) {
            result.push(convertV8LogIntoCpuProfile(profile));
        } else if (isCPUProfile(profile)) {
            profile = unrollHeadToNodesIfNeeded(profile);
            profile = unwrapSamplesIfNeeded(profile);
            convertParentIntoChildrenIfNeeded(profile);
            normalizeCpuProfile(profile);
            Object.assign(profile, extensions);
            result.push(profile);
        } else {
            rejectData('Bad format', {
                view: 'md', source: [
                    'CPUpro supports the following formats:',
                    ...supportedFormats
                ]
            });

            throw new Error('Bad format');
        }

        // return only the first profile until multi-profile mode is fully implemented
        if (!FEATURE_MULTI_PROFILES) {
            break;
        }
    }

    return result;
}

export function extractAndValidate(data: unknown, rejectData: (reason: string, view?: unknown) => void) {
    let extensions: V8CpuProfileCpuproExtensions = {};
    let result: UniformProfilingDataset | null = null;

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
        const session = extractFromChromiumPerformanceProfile(data);
        session.profiles = processProfiles(session.profiles, extensions, rejectData);
        result = createProfilingDataset([session]);
    } else if (Array.isArray(data)) {
        const profiles = data.map(entry =>
            // in case input is array of { profile } object
            'profile' in entry && entry.profile ? entry.profile : entry
        );

        if (isV8LogProfile(profiles[0]) || isCPUProfile(profiles[0])) {
            result = createProfilingDataset([
                createProfilingSession(processProfiles(profiles, extensions, rejectData))
            ]);
        }
    } else if (isV8LogProfile(data) || isCPUProfile(data)) {
        result = createProfilingDataset([
            createProfilingSession(processProfiles([data], extensions, rejectData))
        ]);
    } else {
        rejectData('Unknown format');
        throw new Error('Unknown format');
    }

    if (!result || result.sessions.length === 0) {
        rejectData('Profile sessions not found');
        throw new Error('Profile sessions not found');
    }

    return result;
}
