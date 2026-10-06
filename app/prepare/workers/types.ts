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
    ranges: FunctionRanges<number>;
};
