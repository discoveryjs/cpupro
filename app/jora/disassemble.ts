import type { CpuProCallFrame, CpuProCallFrameCode } from '../prepare/types.js';
import { InlineTreeEntry, PositionTableEntry, methods as positionTableMethods } from './position-table.js';
import { bytecodeHandlersDict } from '../dicts/bytecode-handlers.js';
import { hasOwn } from '@discoveryjs/discovery/utils';

const bytecodeLineRx = /^(\s*\d+\s+[SE]>)?(\s+0[x0][a-f0-9]+\s+)(@\s*\d+\s*:)((?:\s+[a-f0-9]{2})+\s+)(\S+)((?:\s+[\[#<a-z]\S+\s*,)*\s*[\[#<a-z]\S+)?(\s*\([^)]+\))?(\s*;;;.+)?/i;
const machineCodeLineRx = /^(\s*0[x0][a-f0-9]+\s+)([a-f0-9]+\s+)([a-f0-9]+\s+)(REX\.\S+\s+)?(\S+(?: pool begin)?)((?:\s+(?:[#<a-z\d]\S+(?:\s+#[a-f0-9]+)?|\[[^\]]+(?:,\s*\S+)?\]!?)\s*,)*\s*(?:[#<a-z\d]\S+(?:\s+#[a-f0-9]+)?|\[[^\]]+(?:,\s*\S+)?\]!?))?(\s*\(addr [^)]+\))?(\s*(?:\(root \([^)]+\)\)|\([^)]+\)|<\S+>))?(\s*;;.+)?/i;

export type DisassembleBlock = {
    id: `B${number}` | 'constants' | 'deopts';
    code: CpuProCallFrameCode;
    compiler: string;
    originCallFrame: CpuProCallFrameCode['callFrame'];
    originOffset: number;
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

function getBytecodeDefinition(name: string) {
    if (hasOwn(bytecodeHandlersDict, name)) {
        return bytecodeHandlersDict[name];
    }

    if (name.endsWith('.Wide') || name.endsWith('.ExtraWide')) {
        return getBytecodeDefinition(name.slice(0, name.indexOf('.')));
    }

    return null;
}

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

function getCodeInlinedTables(code: CpuProCallFrameCode) {
    const offsets: number[] = [];
    const callFrames: CpuProCallFrame[] = [];

    for (const entry of positionTableMethods.parseInlined(code.inlined)) {
        offsets.push(entry.parent !== undefined ? offsets[entry.parent] : entry.offset);
        callFrames.push(code.fns[entry.fn]);
    }

    return { offsets, callFrames };
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

    disassembleBlocksAndRanges: `{
        $blocks: disassembleBlocks().({
            block: $,
            ranges: instructions.disassembleRanges()
        });
        $pcToBlockMap: $blocks.disassemblePcToBlockMap();
        $commonAddressPrefixMap: $pcToBlockMap.keys().commonPrefixMap(2);

        code: @,
        warnings: [
            not hasSource() ? 'Mapping to source code is not available, because the call frame has **no source code**',
            no positions and tier != 'Ignition' ? 'Mapping to source code is not available, because the call frame has **no position table**'
        ].[],
        $blocks.({
            block,
            ranges: ranges + ranges.(
                $source;
                $start: range[0];
                $end: range[1];

                type = 'pc' ? (
                    { type: 'pc-common', $source, range: [$start, $start + $commonAddressPrefixMap[source[$start:$end]]] }
                ) :
                type = 'hint' ? (
                    (source[$start:$end].match(/^\\((\\S+)\\s*@\\s*(\\d+)\\)$/) |? (
                        $maybePc: matched[1];
                        $maybePc in $commonAddressPrefixMap ? [
                            { type: 'pc', $source, range: [$start + 1, $start + 1 + $maybePc.size()] },
                            { type: 'pc-common', $source, range: [$start + 1, $start + 1 + $commonAddressPrefixMap[$maybePc]] },
                            { $offset: matched[2]; type: 'offset', $source, range: [$end - 1 - $offset.size(), $end - 1] },
                            { type: 'block-ref', $source, range: [$start + 1, $start + 1], marker: $pcToBlockMap[$maybePc].id }
                        ]
                    )) or
                    (source[$start:$end].match(/^\\(addr\\s+(\\S+?)\\)$/) |? (
                        $maybePc: matched[1];
                        $maybePcZ: $maybePc.replace(/0x0+/, '0x');
                        $s: $end - $maybePc.size() - 1;
                        $maybePc in $commonAddressPrefixMap or $maybePcZ in $commonAddressPrefixMap ? (
                            $end_: $s + ($maybePc in $commonAddressPrefixMap
                                ? $commonAddressPrefixMap[$maybePc]
                                : $commonAddressPrefixMap[$maybePcZ] + ($maybePc.size() - $maybePcZ.size())
                            );
                            [
                                { type: 'pc', $source, range: [$s, $end - 1] },
                                { type: 'pc-common', $source, range: [$s, $end_] },
                                { type: 'block-ref', $source, range: [$s, $s], marker: $pcToBlockMap[$maybePc] or $pcToBlockMap[$maybePcZ] | id }
                            ]
                        )
                    ))
                ) :
                type = 'param' ? (
                    $value: source[$start:$end];
                    $value in $commonAddressPrefixMap ? [
                        { type: 'pc', $source, range: [$start, $start + $value.size()] },
                        { type: 'pc-common', $source, range: [$start, $start + $commonAddressPrefixMap[$value]] },
                        { type: 'block-ref', $source, range: [$start, $start], marker: $pcToBlockMap[$value].id }
                    ] :
                    $value ~= /^ls[lr] / ? (
                        { type: 'command', $source, range: [$start, $start + 3] }
                    )
                )
            )
        })
    }`,

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
            originCallFrame: CpuProCallFrame,
            originOffset: number,
            offset = originOffset,
            inlineId = -1,
            id: DisassembleBlock['id'] = `B${blocks.length}`
        ) => blocks.push({
            id,
            code,
            compiler: code.tier,
            originCallFrame,
            originOffset,
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
            const codeInlined = getCodeInlinedTables(code);
            let buffer: string[] = [];
            let originCallFrame = code.callFrame;
            let blockOffset = originCallFrame.start ?? -1;
            let inlineId = -1;
            let blockId: DisassembleBlock['id'] | undefined = undefined;
            const flushBlock = () => {
                if (buffer.length > 0) {
                    pushBlock(
                        buffer.join('\n'),
                        originCallFrame,
                        blockOffset,
                        inlineId !== -1 ? codeInlined.offsets[inlineId] : blockOffset,
                        inlineId,
                        blockId
                    );
                    buffer = [];
                }
            };

            for (const line of lines) {
                const codeOffset = parseInt(line.match(/^0[x0]\S+\s+(\S+)/)?.[1] || '-1', 16);
                const positionTableEntry = blockStartPositions.get(codeOffset);

                if (positionTableEntry !== undefined) {
                    flushBlock();
                    blockOffset = positionTableEntry.offset;
                    inlineId = positionTableEntry.inline ?? -1;
                    originCallFrame = inlineId !== -1
                        ? codeInlined.callFrames[inlineId]
                        : code.callFrame;
                } else {
                    const isConstantPoolBound = (
                        (blockId === undefined && line.indexOf('constant pool begin') !== -1) ||
                        (blockId === 'constants' && line.indexOf('constant') === -1)
                    );
                    const isDeoptsBound = !isConstantPoolBound &&
                        (blockId !== 'deopts' && line.indexOf(';; debug: deopt position') !== -1);

                    if (isConstantPoolBound || isDeoptsBound) {
                        flushBlock();
                        inlineId = -1;
                        originCallFrame = code.callFrame;
                        blockOffset = originCallFrame.start ?? -1;

                        if (isDeoptsBound || (isConstantPoolBound && blockId === 'constants')) {
                            blockId = 'deopts';
                        } else if (isConstantPoolBound && blockId !== 'constants') {
                            blockId = 'constants';
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
