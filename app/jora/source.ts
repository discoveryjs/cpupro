import type { CpuProCallFrame } from '../prepare/types.js';

export const methods = {
    hasSource: `
        $sourceDefined: => is string and size() > 0;
        callFrame
            | $ or @
            | is object and marker('call-frame').object
            ? regexp is string or (script.source is $sourceDefined and (end - start) > 0)
            : (script
                | $ or @
                | is object and marker('script').object
                | source is $sourceDefined)
    `,

    offsetToLineColumn(offset: number, source: string | CpuProCallFrame, callFrame?: CpuProCallFrame) {
        let lastIndex = 0;
        let line = 0;
        let column = 0;

        if (source && typeof source !== 'string' && !callFrame &&
            typeof source.script?.source === 'string' &&
            Number.isFinite(source.start) &&
            Number.isFinite(source.line) &&
            Number.isFinite(source.end)) {
            callFrame = source;
            source = source.script.source;
        }

        if (typeof source !== 'string') {
            return null;
        }

        if (offset < 0) {
            offset = 0;
        } else if (offset > source.length) {
            offset = source.length;
        }

        if (callFrame && Number.isFinite(callFrame.start) && callFrame.start >= 0) {
            lastIndex = callFrame.start;
            line = callFrame.line;
            column = callFrame.column;

            if (callFrame.end >= callFrame.start && offset > callFrame.end) {
                offset = callFrame.end;
            }
        }

        const nlRx = /\r\n?|\n/g;
        nlRx.lastIndex = lastIndex;
        while (nlRx.exec(source) !== null) {
            if (nlRx.lastIndex > offset) {
                column += offset - lastIndex;
                break;
            }

            lastIndex = nlRx.lastIndex;
            line++;
            column = 0;
        }

        return { line, column };
    }
};
