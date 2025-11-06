/**
 * Lines module - handles creation of different profiling lines (dimensions).
 *
 * Each line represents a different metric domain (time, memory, GC, etc.) with:
 * - Unified structure (samples, values, dimensions)
 * - Independent axis and metrics
 * - Shared trees and dictionaries
 * - Cross-line mappings for correlation
 */

export {
    createTimeline,
    type TimelineSourceInfo,
    type TimelineAxisInfo,
    type TimelineSamplesData,
    type TimelineTreesData
} from './timeline.mjs';
export { createMemline } from './memline.mjs';
