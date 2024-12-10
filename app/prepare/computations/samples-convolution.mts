import type { Profile } from '../profile.mjs';
import { CpuProCallFrame } from '../types.js';
import { SampleConvolutionRule } from './call-tree.js';

export const allConvolutionRule = function () {
    return true;
} satisfies SampleConvolutionRule<CpuProCallFrame>;

export const topLevelConvolutionRule = function(_, parent) {
    return parent.entry.id !== 1;
} satisfies SampleConvolutionRule<CpuProCallFrame>;

export const moduleConvolutionRule = function (self, parent) {
    return (
        (self.treeSamplesCount <= 3 && parent.entry.id !== 1) ||
        self.entry.module === parent.entry.module
    );
} satisfies SampleConvolutionRule<CpuProCallFrame>;

export const profilePresenceConvolutionRule = function (self, parent/* , root*/) {
    return (
        self.profilePresence < 1.0 &&
        self.treeSamplesCount <= 3 &&
        parent.entry.id !== 1
    );
} satisfies SampleConvolutionRule<CpuProCallFrame>;

export function setSamplesConvolutionRule(
    profiles: Profile[],
    callFramesProfilePresence: Float32Array,
    rule: SampleConvolutionRule<CpuProCallFrame> | null = null
) {
    for (let i = 0; i < profiles.length; i++) {
        const profile = profiles[i];
        // const codesByCallFrame = profile.codesByCallFrame.reduce(
        //     (map, entry) => map.set(entry.callFrame, entry),
        //     new Map()
        // );
        profile.callFramesTree.setSamplesConvolutionRule(
            rule || (() => false),
            {
                treeSamplesCount: profile.callFramesTreeTimings.samplesCount,
                dictSamplesCount: profile.callFramesTimings.samplesCount,
                profilePresence: callFramesProfilePresence
            }
        );
        profile.recomputeTimings();
    }
}
