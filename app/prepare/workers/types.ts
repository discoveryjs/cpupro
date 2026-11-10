import type { SourceMetrics } from '../misc/source-text-metrics';
import type { FunctionRanges } from '../misc/parse-script-source-ranges';

export type ParseSourceWorkerScript = {
    id: string;
    url: string;
    source: string;
}
export type ParseSourceWorkerScriptResult = {
    id: string;
    sourceMetrics: SourceMetrics;
    // the ranges are posted in the columns of the message and are empty here
    ranges: FunctionRanges;
    rangeCount: number;
};
