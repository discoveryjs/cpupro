import { isCPUProfile } from './cpuprofile.js';
import {
    isChromiumTimeline,
    extractCpuProfilesFromChromiumTimeline
} from './chromium-timeline.js';

// function isCPUProfileMerge(data) {
//     return data && Array.isArray(data.nodes) && Array.isArray(data.profiles);
// }

export function convertValidate(data, rejectData) {
    // see https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/preview#heading=h.lc5airzennvk
    if (isChromiumTimeline(data)) {
        const result = extractCpuProfilesFromChromiumTimeline(data);

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
                    '* V8 CPU profile (.cpuprofile)',
                    '* Chromium timeline / Trace Event format (.json)'
                ] }
            ]
        });
    }

    return data;
}
