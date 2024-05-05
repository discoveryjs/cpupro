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
    executionContexts: Context[];
    scripts?: Script[];
    payload: {
        traceEvents: TraceEvent[];
    }
};

export function isDevToolsEnhancedTraces(data) {
    const { meta } = data || {};

    if (meta && meta.fileDocumentType === 'x-msedge-session-log' && meta.type === 'performance') {
        return true;
    }

    return false;
}

export function extractFromDevToolsEnhancedTraces(data: DevToolsEnchandedTraces) {
    const result = {
        ...data.payload,
        executionContexts: data.executionContexts?.map(ctx => ({
            origin: ctx.origin,
            name: ctx.name
        }))?.filter(ctx => ctx.name),
        scripts: data.scripts?.map(script => ({
            id: Number(script.scriptId),
            url: script.url,
            source: script.sourceText
        }))?.filter(script => script.source)
    };

    console.log(result);

    return result;
}
