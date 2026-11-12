import type { SourceMetrics } from '../misc/source-text-metrics';

export type ParseSourceWorkerScript = {
    id: string;
    url: string;
    source: string;
}
export type ParseSourceWorkerScriptResult = {
    id: string;
    sourceMetrics: SourceMetrics;
    parsed: boolean;
    error?: string;
    // the ranges, their index and the line starts are posted in the columns of the message
    rangeCount: number;
    indexCount: number;
    lineCount: number;
};
