import { parseJsName } from './functions.js';
import type { CallFrame, CallNode, Code, CodeCallFrameInfo, Script, V8LogProfile } from './types.js';

export const VM_STATE_JS = 0;
export const VM_STATE_GC = 1;
export const VM_STATE_OTHER = 5;
export const VM_STATE_EXTERNAL = 6;
export const VM_STATE_IDLE = 7;
export const vmState = [
    'js',
    'garbage collector',
    'parser',
    'compiler bytecode',
    'compiler',
    'other',
    'external',
    'idle',
    'atomics wait',
    'logging'
] as const;
const vmStateIgnoreStack = new Uint32Array(vmState.length);
vmStateIgnoreStack[VM_STATE_GC] = 1; // FIXME: probably stack is available on GC, but in cpuprofile GC is always on root
vmStateIgnoreStack[VM_STATE_IDLE] = 1;

function findBalancePair(str: string, offset: number, pattern: string): number {
    const stack: string[] = [];
    for (let i = offset; i < str.length; i++) {
        if (stack.length === 0) {
            if (str[i] === pattern) {
                return i;
            }
        } else if (stack[stack.length - 1] === str[i]) {
            stack.pop();
            continue;
        }

        switch (str[i]) {
            case '<': stack.push('>'); break;
            case '(': stack.push(')'); break;
            case '[': stack.push(']'); break;
        }
    }

    return str.length;
}

function cleanupInternalName(name: string): string {
    // cut off ::(anonymous namespace)
    name = name.replace(/::\(.+?\)/g, '');

    // cut off (...) and <...>
    for (let i = 0; i < name.length; i++) {
        switch (name[i]) {
            case '<':
                name = name.slice(0, i) + name.slice(findBalancePair(name, i + 1, '>') + 1);
                i--;
                break;
            case '(':
                name = name.slice(0, i) + name.slice(findBalancePair(name, i + 1, ')') + 1);
                i--;
                break;
        }
    }

    // cut off a types in prefix, i.e. void FunctionName
    const wsIndex = name.lastIndexOf(' ');
    name = wsIndex !== -1
        ? name.slice(wsIndex + 1)
        : name;

    return name;
}

function codeToCallFrameInfo(code: Code, scripts: Script[]): CodeCallFrameInfo {
    if (!code || !code.type) {
        return {
            name: '(unknown)'
        };
    }

    let name = code.name;
    let lowlevel = false;

    switch (code.type) {
        case 'CPP': {
            if (name[1] === ' ') {
                name = cleanupInternalName(name.slice(2));
            }
            break;
        }

        case 'SHARED_LIB': {
            // FIXME: there is no way in cpuprofile to express shared libs at the moment,
            // so represent them as (program) for now
            name = '(LIB) ' + name; // '(program)';
            lowlevel = true;
            break;
        }

        case 'JS': {
            const scriptId = code.source?.script;
            const script = typeof scriptId === 'number' ? scripts?.[scriptId] : undefined;
            const { functionName, scriptUrl, line, column } = parseJsName(name, script);

            return {
                name: functionName,
                file: scriptUrl,
                line,
                column
            };
        }

        case 'CODE': {
            switch (code.kind) {
                case 'LoadIC':
                case 'StoreIC':
                case 'KeyedStoreIC':
                case 'KeyedLoadIC':
                case 'LoadGlobalIC':
                case 'Handler':
                    name = '(IC) ' + name;
                    lowlevel = true;
                    break;

                case 'BytecodeHandler':
                    name = '(bytecode) ~' + name;
                    lowlevel = true;
                    break;

                case 'Stub':
                    name = '(stub) ' + name;
                    lowlevel = true;
                    break;

                case 'Builtin':
                    name = '(builtin) ' + name;
                    lowlevel = true;
                    break;

                case 'RegExp':
                    name = 'RegExp: ' + name;
                    break;
            }

            break;
        }

        default: {
            name = `(${code.type}) ${name}`;
        }
    }

    return { name, lowlevel };
}

function createCallFrame(
    functionName: string,
    url = '',
    lineNumber = -1,
    columnNumber = -1,
    scriptId = 0,
    functionId: number | null = null
): CallFrame {
    return {
        scriptId,
        functionId,
        functionName,
        url,
        lineNumber,
        columnNumber
    };
}

function createNode(id: number, callFrame: CallFrame): CallNode {
    return {
        id,
        callFrame,
        children: []
    };
}

export function processTicks(v8log: V8LogProfile) {
    const scriptIdByUrl = new Map<string, number>([['', 0]]);
    const getScriptIdByUrl = (url: string) => scriptIdByUrl.has(url)
        ? scriptIdByUrl.get(url)
        : scriptIdByUrl.set(url, scriptIdByUrl.size).size - 1;
    const vmStateCallFrames = vmState.map(name =>
        name !== 'js'
            ? createCallFrame(`(${
                // https://github.com/v8/v8/blob/2be84efd933f6e1e29b0c508a1035ed7d13d7127/src/profiler/symbolizer.cc#L34
                name == 'other' || name === 'external' || name === 'logging'
                    ? 'program'
                    : name
            })`)
            : null
    );
    const rootCallFrame = createCallFrame('(root)');
    const programCallFrame = createCallFrame('(program)');
    const callFrameById = new Map<number, CallFrame | null>();
    const rootNode = createNode(1, rootCallFrame);
    const rootNodeMap = new Map<CallFrame, CallNode>();
    const nodes = [rootNode];
    const nodesTransition = new Map<number, Map<CallFrame, CallNode>>([[1, rootNodeMap]]);
    let nodeIdSeed = 1;
    let lastTm = 0;
    const timeDeltas = new Array(v8log.ticks.length);
    const samples = new Array(v8log.ticks.length);

    v8log.ticks.sort((a, b) => a.tm - b.tm);

    for (let tickIndex = 0; tickIndex < v8log.ticks.length; tickIndex++) {
        const tick = v8log.ticks[tickIndex];
        let vmStateCallFrame = vmStateCallFrames[tick.vm];
        let currentNode = rootNode;
        let currentNodeMap = rootNodeMap;

        if (vmStateIgnoreStack[tick.vm] !== 1) {
            for (let i = tick.s.length - 2; i >= 0; i -= 2) {
                const id = tick.s[i];

                if (id === -1) {
                    continue;
                }

                let callFrame = callFrameById.get(id);

                if (callFrame === undefined) {
                    if (id > v8log.code.length) {
                        // treat unknown ids as a memory address
                        callFrame = createCallFrame(`0x${id.toString(16)}`);
                    } else {
                        const code = v8log.code[id];

                        // FIXME: ignore Abort.Wide/ExtraWide for now since it too noisy;
                        // not sure what it stands for, but looks like an execution pause
                        if (code.kind === 'BytecodeHandler') {
                            if (code.name === 'Abort.Wide' || code.name === 'Abort.ExtraWide') {
                                continue;
                            }
                        }

                        const { name, file, line, column, lowlevel } = codeToCallFrameInfo(code, v8log.scripts);
                        callFrame = lowlevel ? null : createCallFrame(
                            name,
                            file,
                            line,
                            column,
                            code.source ? code.source.script : getScriptIdByUrl(file || ''),
                            typeof code.func === 'number' ? code.func : null
                        );
                    }

                    callFrameById.set(id, callFrame);
                }

                // skip ignored call frames
                if (callFrame === null) {
                    continue;
                }

                let nextNode = currentNodeMap.get(callFrame);

                if (nextNode === undefined) {
                    nextNode = createNode(++nodeIdSeed, callFrame);
                    nodes.push(nextNode);
                    currentNodeMap.set(callFrame, nextNode);
                    currentNode.children.push(nextNode.id);
                    nodesTransition.set(nodeIdSeed, currentNodeMap = new Map());
                } else {
                    currentNodeMap = nodesTransition.get(nextNode.id) as Map<CallFrame, CallNode>;
                }

                currentNode = nextNode;
            }
        }

        if (vmStateCallFrame === null && currentNode === rootNode) {
            // v8 profiler uses (program) in case no stack captured
            // https://github.com/v8/v8/blob/2be84efd933f6e1e29b0c508a1035ed7d13d7127/src/profiler/symbolizer.cc#L174
            vmStateCallFrame = programCallFrame;
        }

        if (vmStateCallFrame !== null) {
            let node = currentNodeMap.get(vmStateCallFrame);

            if (node === undefined) {
                node = createNode(++nodeIdSeed, vmStateCallFrame);
                nodes.push(node);
                currentNodeMap.set(vmStateCallFrame, node);
                currentNode.children.push(node.id);
                nodesTransition.set(nodeIdSeed, new Map());
            }

            currentNode = node;
        }

        samples[tickIndex] = currentNode.id;
        timeDeltas[tickIndex] = tick.tm - lastTm;

        lastTm = tick.tm;
    }

    return {
        nodes,
        samples,
        timeDeltas
    };
}
