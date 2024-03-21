export function isDevToolsEnhancedTraces(data) {
    const { meta } = data || {};

    if (meta && meta.fileDocumentType === 'x-msedge-session-log' && meta.type === 'performance') {
        return true;
    }

    return false;
}
