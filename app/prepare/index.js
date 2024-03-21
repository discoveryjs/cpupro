import { isCPUProfile } from './cpuprofile.js';
import { isDevToolsEnhancedTraces } from './formats/chromium-devtools-enhanced-traces.js';
import {
    isChromiumPerformanceProfile,
    extractFromChromiumPerformanceProfile
} from './formats/chromium-performance-profile.js';

export const supportedFormats = [
    '* [V8 CPU profile](https://v8.dev/docs/profile) (.cpuprofile)',
    '* [Chromium Performance Profile](https://developer.chrome.com/docs/devtools/performance/reference#save) / [Trace Event](https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/preview) format (.json)',
    '* [Edge Enhanced Performance Traces](https://learn.microsoft.com/en-us/microsoft-edge/devtools-guide-chromium/experimental-features/share-traces) (.devtools)'
];
export const supportedFormatsText = supportedFormats
    .map(line => line.replace(/\[(.+?)\]\(.*?\)/g, '$1'));

// function isCPUProfileMerge(data) {
//     return data && Array.isArray(data.nodes) && Array.isArray(data.profiles);
// }

export function convertValidate(data, rejectData) {
    if (isDevToolsEnhancedTraces(data)) {
        data = data.payload;
    }

    // see https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/preview#heading=h.lc5airzennvk
    if (isChromiumPerformanceProfile(data)) {
        const result = extractFromChromiumPerformanceProfile(data);

        data = result.profiles[result.indexToView] || result.profiles[0];

        if (!data) {
            rejectData('CPU profile data not found');
        }
    }

    // if (isCPUProfileMerge(data)) {
    //     return {
    //         ...data.profiles[2],
    //         nodes: data.nodes,
    //         profiles: data.profiles
    //     };
    // }

    if (!isCPUProfile(data)) {
        rejectData('Bad format', {
            view: 'alert-warning',
            content: [
                { view: 'h3', content: [
                    'badge:"Error"',
                    'text:"Bad format"'
                ] },
                { view: 'md', source: [
                    'CPU (pro)file supports the following formats:',
                    ...supportedFormats
                ] }
            ]
        });
    }

    return data;
}
