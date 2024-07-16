import { RuntimeCode, V8CpuProfileExecutionContext, V8CpuProfileScript } from '../types.js';

type Context = {
    origin: string;
    name: string;
};
type Script = {
    scriptId: string | number;
    url: string;
    sourceText?: string;
};
type TraceEvent = {
    [k: string]: unknown;
};
type DevToolsEnchandedTraces = {
    meta: {
        version: number;
        fileDocumentType: string;
        userAgentVersion: string;
        type: string;
    }
    executionContexts: Context[];
    scripts?: Script[];
    payload: {
        traceEvents: TraceEvent[];
    }
};

export function isDevToolsEnhancedTraces(data: unknown): data is DevToolsEnchandedTraces {
    const { meta } = data as Partial<DevToolsEnchandedTraces>;

    if (meta && meta.fileDocumentType === 'x-msedge-session-log' && meta.type === 'performance') {
        return true;
    }

    return false;
}

export function extractFromDevToolsEnhancedTraces(data: DevToolsEnchandedTraces) {
    const scripts: V8CpuProfileScript[] = [];
    const executionContexts: V8CpuProfileExecutionContext[] = [];

    for (const script of data.scripts || []) {
        if (script.sourceText) {
            scripts.push({
                id: Number(script.scriptId),
                url: script.url,
                source: script.sourceText
            });
        }
    }

    for (const ctx of data.executionContexts || []) {
        if (ctx.name) {
            executionContexts.push({
                origin: ctx.origin,
                name: ctx.name
            });
        }
    }

    const result = {
        ...data.payload,
        runtime: 'edge' satisfies RuntimeCode as RuntimeCode, // FIXME: temporary solution, there is no way for now to detect Edge, however this format is supported by Edge only for now
        executionContexts,
        scripts
    };

    return result;
}
