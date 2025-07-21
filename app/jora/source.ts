import { methods as positionTableMethods } from './position-table.js';
import type { CpuProCallFrame, CpuProCallFrameCode } from '../prepare/types.js';
import { bytecodeHandlersDict } from '../dicts/bytecode-handlers.js';
import { hasOwn } from '@discoveryjs/discovery/utils';

const bytecodeLineRx = /^(\s*\d+\s+[SE]>)?(\s+0[x0][a-f0-9]+\s+)(@\s*\d+\s*:)((?:\s+[a-f0-9]{2})+\s+)(\S+)((?:\s+[\[#<a-z]\S+\s*,)*\s*[\[#<a-z]\S+)?(\s*\([^)]+\))?(\s*;;;.+)?/i;
const machineCodeLineRx = /^(\s*0[x0][a-f0-9]+\s+)([a-f0-9]+\s+)([a-f0-9]+\s+)(REX\.\S+\s+)?(\S+)((?:\s+(?:[#<a-z\d]\S+(?:\s+#[a-f0-9]+)?|\[[^\]]+(?:,\s*\S+)?\]!?)\s*,)*\s*(?:[#<a-z\d]\S+(?:\s+#[a-f0-9]+)?|\[[^\]]+(?:,\s*\S+)?\]!?))?(\s*\(addr [^)]+\))?(\s*(?:\([^)]+\)|\(root \([^)]+\)\)|<\S+>))?(\s*;;.+)?/i;

function commonPrefix(a: string, b: string, max: number = Infinity) {
    let i = 0;

    for (const len = Math.min(a.length, b.length, max); i < len; i++) {
        if (a[i] !== b[i]) {
            break;
        }
    }

    return i;
}

function nonWsRange(s: string, start = 0, end = s.length) {
    for (; start < end; start++) {
        if (s[start] !== ' ') {
            break;
        }
    }

    for (; end > start; end--) {
        if (s[end - 1] !== ' ') {
            break;
        }
    }

    return { start, end };
}

function getBytecodeDefinition(name: string) {
    if (hasOwn(bytecodeHandlersDict, name)) {
        return bytecodeHandlersDict[name];
    }

    if (name.endsWith('.Wide') || name.endsWith('.ExtraWide')) {
        return getBytecodeDefinition(name.slice(0, name.indexOf('.')));
    }

    return null;
}

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
    },

    sourceFragment: `
        $source: @ or '';
        $limitStart: $$.limitStart or $$.limit or 50;
        $limitEnd: $$.limitEnd or $$.limit or 50;
        $hasSource: $source.bool();
        $sourceOffset: $$.scriptOffset or $$.offset | $hasSource and $ > 0 ? $ : 0;
        $lineStart: $source.lastIndexOf('\\n', $sourceOffset - 1) + 1;
        $lineEnd: $source.indexOf('\\n', $sourceOffset) | $ != -1 ? $source[$ - 1] != '\\r' ?: $ - 1 : $source.size();
        $line: $source[$lineStart:$lineEnd];
        $lineRelStart: $line.match(/^\\s*/).matched[].size();
        $lineRelEnd: $lineEnd - $lineStart;
        $lineRelOffset: $sourceOffset - $lineStart;
        $lineSliceStart: [$lineRelStart, $lineRelOffset - $limitStart - ($lineRelEnd - $lineRelOffset | $ >= $limitEnd ? 0 : $limitEnd - $)].max();
        $lineSliceEnd: [$lineRelEnd, $lineRelOffset + $limitEnd + ($lineRelOffset - $lineSliceStart | $ >= $limitStart ? 0 : $limitStart - $)].min();
        $sliceStart: $lineSliceStart + $lineStart;
        $sliceEnd: $lineSliceEnd + $lineStart;
        $lineNum: $source[0:$sourceOffset].match(/\\r\\n?|\\n/g).size() + 1;
        $prefix: $sliceStart != $lineStart + $lineRelStart ? '…' : '';
        $offsetCorrection: $sliceStart - $prefix.size();

        { $hasSource, $source, $sourceOffset, $lineNum, $lineStart, $lineEnd, $sliceStart, $sliceEnd, $offsetCorrection, slice: $hasSource
            ? [
                $prefix,
                $source[$sliceStart:$sliceEnd],
                $sliceEnd != $lineEnd ? '…' : ''
              ].join('')
            : '(source is unavailable)'
        }
    `,

    commonPrefixMap(strings: string[], minLength = 2) {
        const map = {};
        let prev = strings[0];
        let common = prev.length - Math.max(minLength, 1);

        map[prev] = common;

        for (let i = 1; i < strings.length; i++) {
            const value = strings[i];

            common = commonPrefix(prev, value, common);
            map[value] = common;

            prev = value;
        }

        return map;
    },

    assembleRanges(assemble: string) {
        const ranges: {
            type: string;
            source: string;
            range: [number, number];
            command?: ReturnType<typeof getBytecodeDefinition>;
            param?: string;
        }[] = [];
        const pushRange = (type: string, m: string, mStart = 0, mEnd = m?.length) => {
            if (typeof m !== 'string' || !m) {
                return;
            }

            const { start, end } = nonWsRange(m, mStart, mEnd);
            const range: (typeof ranges)[number] = {
                type,
                source: assemble,
                range: [offset + start, offset + end]
            };

            ranges.push(range);
            offset += m.length;

            return range;
        };
        let lineOffset = 0;
        let offset = 0;

        if (bytecodeLineRx.test(assemble)) {
            // Ignition
            for (const line of assemble.match(/.*(\n|$)/g) || []) {
                offset = lineOffset;

                const m = line.match(bytecodeLineRx);

                if (m) {
                    const [, label, pc, codeOffset, ops, command, params, hint, comment] = m;
                    const commandDef = getBytecodeDefinition(command);

                    pushRange('label', label);
                    pushRange('pc', pc);
                    pushRange('offset', codeOffset, 1, codeOffset.length - 1);
                    pushRange('ops', ops);

                    if (command) {
                        const range = pushRange('command', command);
                        if (range) {
                            range.command = commandDef;
                        }
                    }

                    if (params) {
                        const paramList = params.split(',');
                        for (let i = 0; i < paramList.length; i++) {
                            if (i !== 0) {
                                offset++;
                            }

                            const range = pushRange('param', paramList[i]);
                            if (range) {
                                range.command = commandDef;
                                range.param = commandDef?.params[i];
                            }
                        }
                    }

                    pushRange('hint', hint);
                    pushRange('comment', comment);
                }

                lineOffset += line.length;
            }
        } else {
            for (const line of assemble.match(/.*(\n|$)/g) || []) {
                offset = lineOffset;

                const m = line.match(machineCodeLineRx);

                if (m) {
                    const [, pc, codeOffset, ops, prefix, command, params, ref, hint, comment] = m;

                    pushRange('pc', pc);
                    pushRange('offset', codeOffset);
                    pushRange('ops', ops);
                    pushRange('prefix', prefix);
                    pushRange('command', command);

                    if (params) {
                        const paramList = params.split(',');
                        for (let i = 0; i < paramList.length; i++) {
                            if (i !== 0) {
                                offset++;
                            }

                            let param = paramList[i];

                            if (i !== paramList.length - 1) {
                                const { start, end } = nonWsRange(param);

                                if (param[start] === '[' && param[end - 1] !== ']') {
                                    const nextParam = paramList[i + 1];

                                    if (nextParam.endsWith(']') || nextParam.endsWith(']!')) {
                                        param += ',' + nextParam;
                                        i++;
                                    }
                                }
                            }

                            pushRange('param', param);
                        }
                    }

                    pushRange('hint', ref);
                    pushRange('hint', hint);
                    pushRange('comment', comment);
                }

                lineOffset += line.length;
            }
        }

        return ranges;
    },

    assembleBlocks(code: CpuProCallFrameCode) {
        type Block = {
            index: number;
            callFrame: CpuProFunctionCode['callFrame'];
            offset: number;
            code: CpuProFunctionCode;
            compiler: string;
            instructions: string;
        };

        if (!code?.disassemble?.instructions) {
            return;
        }

        const callFrame = code.callFrame;
        const blocks: Block[] = [];
        const pushBlock = (offset: number, instructions: string) => blocks.push({
            index: blocks.length,
            code,
            compiler: code.tier,
            callFrame,
            offset,
            instructions
        });

        if (code.tier === 'Ignition') {
            for (const instructions of code.disassemble.instructions.split(/\n(?=\s*\d+\s+[SE]>)/)) {
                pushBlock(
                    Number(instructions.match(/^\s*(\d+)\s/)?.[1] || callFrame.start || -1),
                    instructions
                );
            }
        } else {
            const lines = code.disassemble.instructions.split(/\r\n?|\n/);
            const blockStartPositions = positionTableMethods
                .parsePositions(code.positions)
                .reduce((map, entry) => map.set(entry.code, entry.offset), new Map());
            let buffer: string[] = [];
            let blockOffset = callFrame.start || -1;
            const flushBlock = () => {
                if (buffer.length > 0) {
                    pushBlock(blockOffset, buffer.join('\n'));
                    buffer = [];
                }
            };

            for (const line of lines) {
                const codeOffset = parseInt(line.match(/^0[x0]\S+\s+(\S+)/)?.[1] || '-1', 16);
                const offset = blockStartPositions.get(codeOffset);

                if (offset !== undefined) {
                    flushBlock();
                    blockOffset = offset;
                }

                buffer.push(line);
            }

            flushBlock();
        }

        return blocks;
    }
};
