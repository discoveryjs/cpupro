import type { CpuProCallFrame, CpuProCallFrameCode } from '../prepare/types.js';
import { InlineTreeEntry, PositionTableEntry, methods as positionTableMethods } from './position-table.js';
import { bytecodeHandlersDict } from '../dicts/bytecode-handlers.js';
import { hasOwn } from '@discoveryjs/discovery/utils';

function getBytecodeDefinition(name: string) {
    if (hasOwn(bytecodeHandlersDict, name)) {
        return bytecodeHandlersDict[name];
    }

    if (name.endsWith('.Wide') || name.endsWith('.ExtraWide')) {
        return getBytecodeDefinition(name.slice(0, name.indexOf('.')));
    }

    return null;
}

const bytecodeLineRx = /^(\s*\d+\s+[SE]>)?(\s+0[x0][a-f0-9]+\s+)(@\s*\d+\s*:)((?:\s+[a-f0-9]{2})+\s+)(\S+)((?:\s+[\[#<a-z]\S+\s*,)*\s*[\[#<a-z]\S+)?(\s*\([^)]+\))?(\s*;;;.+)?/i;
const machineCodeLineRx = /^(\s*0[x0][a-f0-9]+\s+)([a-f0-9]+\s+)([a-f0-9]+\s+)(REX\.\S+\s+)?(\S+(?: pool begin)?)((?:\s+(?:[#<a-z\d]\S+(?:\s+#[a-f0-9]+)?|\[[^\]]+(?:,\s*\S+)?\]!?)\s*,)*\s*(?:[#<a-z\d]\S+(?:\s+#[a-f0-9]+)?|\[[^\]]+(?:,\s*\S+)?\]!?))?(\s*\(addr [^)]+\))?(\s*(?:\(root \([^)]+\)\)|\([^)]+\)|<\S+>))?(\s*;;.+)?/i;

export type DisassembleBlock = {
    id: `B${number}` | 'constant-pool' | 'deopts';
    code: CpuProCallFrameCode;
    compiler: string;
    callFrame: CpuProCallFrameCode['callFrame'];
    offset: number;
    inlineId: number;
    instructions: string;
};

export type DisassembleBlockRange = {
    type: string;
    source: string;
    range: [number, number];
    command?: ReturnType<typeof getBytecodeDefinition>;
    param?: string;
};

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

export const methods = {
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

    disassembleRanges(disassemble: string) {
        const ranges: DisassembleBlockRange[] = [];
        const pushRange = (type: string, m: string, mStart = 0, mEnd = m?.length) => {
            if (typeof m !== 'string' || !m) {
                return;
            }

            const { start, end } = nonWsRange(m, mStart, mEnd);
            const range: DisassembleBlockRange = {
                type,
                source: disassemble,
                range: [offset + start, offset + end]
            };

            ranges.push(range);
            offset += m.length;

            return range;
        };
        let lineOffset = 0;
        let offset = 0;

        if (bytecodeLineRx.test(disassemble)) {
            // Ignition
            for (const line of disassemble.match(/.*(\n|$)/g) || []) {
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
            for (const line of disassemble.match(/.*(\n|$)/g) || []) {
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
                } else if (/^\s+;;/.test(line)) {
                    pushRange('comment', line);
                }

                lineOffset += line.length;
            }
        }

        return ranges;
    },

    disassembleBlocks(code: CpuProCallFrameCode) {
        if (!code?.disassemble?.instructions) {
            return;
        }

        const blocks: DisassembleBlock[] = [];
        const pushBlock = (
            instructions: string,
            callFrame: CpuProCallFrame,
            offset: number,
            inlineId = -1,
            id: DisassembleBlock['id'] = `B${blocks.length}`
        ) => blocks.push({
            id,
            code,
            compiler: code.tier,
            callFrame,
            offset,
            inlineId,
            instructions
        });

        if (code.tier === 'Ignition') {
            for (const instructions of code.disassemble.instructions.split(/\n(?=\s*\d+\s+[SE]>)/)) {
                pushBlock(
                    instructions,
                    code.callFrame,
                    Number(instructions.match(/^\s*(\d+)\s/)?.[1] || code.callFrame.start || -1)
                );
            }
        } else {
            const lines = code.disassemble.instructions.split(/\r\n?|\n/);
            const blockStartPositions = positionTableMethods
                .parsePositions(code.positions)
                .reduce(
                    (map, entry) => map.set(entry.code, entry),
                    new Map<number, PositionTableEntry>()
                );
            const blockInlineCallFrames = code.fns;
            let buffer: string[] = [];
            let callFrame = code.callFrame;
            let blockOffset = callFrame.start ?? -1;
            let inline = -1;
            let id: DisassembleBlock['id'] | undefined = undefined;
            const flushBlock = () => {
                if (buffer.length > 0) {
                    pushBlock(buffer.join('\n'), callFrame, blockOffset, inline, id);
                    buffer = [];
                }
            };

            for (const line of lines) {
                const codeOffset = parseInt(line.match(/^0[x0]\S+\s+(\S+)/)?.[1] || '-1', 16);
                const positionTableEntry = blockStartPositions.get(codeOffset);

                if (positionTableEntry !== undefined) {
                    flushBlock();
                    blockOffset = positionTableEntry.offset;
                    inline = positionTableEntry.inline ?? -1;
                    callFrame = inline !== -1
                        ? blockInlineCallFrames[inline]
                        : code.callFrame;
                } else {
                    const isConstantPoolBound = (
                        (id === undefined && line.indexOf('constant pool begin') !== -1) ||
                        (id === 'constant-pool' && line.indexOf('constant') === -1)
                    );
                    const isDeoptsBound = !isConstantPoolBound &&
                        (id !== 'deopts' && line.indexOf(';; debug: deopt position') !== -1);

                    if (isConstantPoolBound || isDeoptsBound) {
                        flushBlock();
                        inline = -1;
                        callFrame = code.callFrame;
                        blockOffset = callFrame.start ?? -1;

                        if (isDeoptsBound || (isConstantPoolBound && id === 'constant-pool')) {
                            id = 'deopts';
                        } else if (isConstantPoolBound && id !== 'constant-pool') {
                            id = 'constant-pool';
                        }
                    }
                }

                buffer.push(line);
            }

            flushBlock();
        }

        return blocks;
    },

    disassemblePcToBlockMap(blockRanges: { block: DisassembleBlock, ranges: DisassembleBlockRange[] }[]) {
        const map = {};

        for (let i = 0; i < blockRanges.length; i++) {
            const { block, ranges } = blockRanges[i];

            for (const range of ranges) {
                if (range.type === 'pc') {
                    const key = range.source.slice(range.range[0], range.range[1]);

                    map[key] = block;
                }
            }
        }

        return map;
    },

    disassembleBlockTree<T>(array: T[], code: CpuProCallFrameCode, fn: ((entry: T) => DisassembleBlock)) {
        type BlockTreeEntry = T | InlineGroup;
        type InlineGroup = {
            location: { callFrame: CpuProCallFrame; offset: number; };
            inline: InlineTreeEntry;
            children: BlockTreeEntry[];
        };

        if (!code || !Array.isArray(code.fns) || !code.fns.length) {
            return array;
        }

        const result: BlockTreeEntry[] = [];
        const inlineTable = positionTableMethods.parseInlined(code.inlined, code.fns);
        let prevInlinePath: InlineGroup[] = [];

        for (const entry of array) {
            const block = fn(entry);

            if (block.inlineId == -1) {
                result.push(entry);
                prevInlinePath = [];
                continue;
            }

            const inlineTreePath: InlineTreeEntry[] = [];
            let inlineCursor: InlineTreeEntry | null = inlineTable[block.inlineId] ?? null;
            while (inlineCursor != null) {
                inlineTreePath.unshift(inlineCursor);
                inlineCursor = inlineCursor.parent !== undefined
                    ? inlineTable[inlineCursor.parent]
                    : null;
            }

            for (let i = 0, prev = result, currentCallFrame = code.callFrame; i < inlineTreePath.length; i++) {
                const inlineTreePathEntry = inlineTreePath[i];
                let inlinePathEntry = i < prevInlinePath.length && prevInlinePath[i].inline === inlineTreePathEntry
                    ? prevInlinePath[i]
                    : undefined;

                if (inlinePathEntry === undefined) {
                    prev.push(inlinePathEntry = prevInlinePath[i] = {
                        location: {
                            callFrame: currentCallFrame,
                            offset: inlineTreePathEntry.offset
                        },
                        inline: inlineTreePathEntry,
                        children: []
                    });

                    if (i < prevInlinePath.length - 1) {
                        prevInlinePath.splice(i + 1);
                    }
                }

                prev = inlinePathEntry.children;
                currentCallFrame = inlinePathEntry.inline.callFrame as CpuProCallFrame;
            }

            prevInlinePath[prevInlinePath.length - 1].children.push(entry);
        }

        return result;
    }
};
