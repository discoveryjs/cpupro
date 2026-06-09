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
    // profiles: Profile[],
    // callFramesProfilePresence: Float32Array,
    // rule: SampleConvolutionRule<CpuProCallFrame> | null = null
) {
    // FIXME: will fix later, since here we need a bucket instead Profile[]
}
