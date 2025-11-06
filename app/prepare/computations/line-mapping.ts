import { SamplesMetrics } from './metrics.js';

/**
 * Represents mapping between two lines in a profile.
 * Each source sample maps to a target sample that was "current" when source was captured.
 */
export type LineMapping = {
    /**
     * Monotonically increasing vector mapping source sample index to target sample index.
     * mapping[i] = last target sample index when source sample i was captured.
     *
     * Target range for source sample i is: [mapping[i], mapping[i+1])
     */
    sampleToTargetSample: Uint32Array;

    /**
     * Inverse mapping (target → source).
     * Computed eagerly for bidirectional correlation.
     */
    inverse: LineMapping | null;

    _mapping: Uint32Array;
};

/**
 * Build mapping from source line to target line based on axis positions.
 * Maps each source sample to the last target sample that occurred at or before it.
 *
 * @param sourceCumulative - Cumulative axis positions for source line
 * @param targetCumulative - Cumulative axis positions for target line
 * @returns Mapping vector (monotonically increasing)
 */
export function buildLineMapping(
    sourceCumulative: Uint32Array,
    targetCumulative: Uint32Array
): Uint32Array {
    const mapping = new Uint32Array(sourceCumulative.length);
    let targetIdx = 0;

    for (let i = 0; i < sourceCumulative.length; i++) {
        const sourceAxisPos = sourceCumulative[i];

        // Find last target sample where targetCumulative[targetIdx] <= sourceAxisPos
        while (targetIdx < targetCumulative.length - 1 &&
               targetCumulative[targetIdx + 1] <= sourceAxisPos) {
            targetIdx++;
        }

        mapping[i] = targetIdx;
    }

    return mapping;
}

/**
 * Invert a line mapping to enable bidirectional correlation.
 *
 * @param forward - Forward mapping (source → target)
 * @param targetLength - Number of samples in target line
 * @returns Inverse mapping (target → source)
 */
export function invertLineMapping(
    forward: Uint32Array,
    targetLength: number
): Uint32Array {
    const inverse = new Uint32Array(targetLength);

    // For each target sample, find first source sample that maps to it
    let srcIdx = 0;
    for (let tgtIdx = 0; tgtIdx < targetLength; tgtIdx++) {
        // Skip source samples that map to earlier target samples
        while (srcIdx < forward.length && forward[srcIdx] < tgtIdx) {
            srcIdx++;
        }
        inverse[tgtIdx] = srcIdx < forward.length ? srcIdx : forward.length - 1;
    }

    return inverse;
}

/**
 * Create bidirectional mapping between two lines.
 *
 * @param sourceMetrics - SamplesMetrics from source line
 * @param targetMetrics - SamplesMetrics from target line
 * @returns Complete LineMapping with forward and inverse
 */
export function createLineMapping(
    sourceMetrics: SamplesMetrics,
    targetMetrics: SamplesMetrics
): LineMapping {
    const forwardMapping = buildLineMapping(
        sourceMetrics.cumulative,
        targetMetrics.cumulative
    );

    const inverseMapping = invertLineMapping(
        forwardMapping,
        targetMetrics.samples.length
    );

    // Create mapping objects with circular references
    const forward: LineMapping = {
        sampleToTargetSample: forwardMapping,
        inverse: null,
        _mapping: new Uint32Array(sourceMetrics.cumulative.length)
    };

    const inverse: LineMapping = {
        sampleToTargetSample: inverseMapping,
        inverse: forward,
        _mapping: new Uint32Array(targetMetrics.cumulative.length)
    };

    forward.inverse = inverse;

    return forward;
}

/**
 * Translate a sample range from one line to another using mapping.
 *
 * @param startIdx - Start sample index in source line
 * @param endIdx - End sample index in source line (exclusive)
 * @param mapping - Mapping from source to target line
 * @returns Target range { start, end } (end is exclusive)
 */
export function translateRange(
    startIdx: number,
    endIdx: number,
    mapping: LineMapping
): { start: number; end: number } {
    const { sampleToTargetSample } = mapping;

    return {
        start: sampleToTargetSample[startIdx],
        end: endIdx < sampleToTargetSample.length
            ? sampleToTargetSample[endIdx]
            : sampleToTargetSample[sampleToTargetSample.length - 1] + 1
    };
}
