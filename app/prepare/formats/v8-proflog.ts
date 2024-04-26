interface Code {
    name: string;
    type: 'CODE' | 'CPP' | 'JS' | 'SHARED_LIB';
    timestamp?: number;
    kind?:
        | 'Bultin'
        | 'BytecodeHandler'
        | 'Handler'
        | 'KeyedLoadIC'
        | 'KeyedStoreIC'
        | 'LoadGlobalIC'
        | 'LoadIC'
        | 'Opt'
        | 'StoreIC'
        | 'Stub'
        | 'Unopt'
        | 'Builtin'
        | 'RegExp';
    func?: number;
    tm?: number;
    source?: {
        script: number;
        start: number;
        end: number;
        positions: string;
        inlined: string;
        fns: number[];
    }
}

interface ProfileFunction {
    name: string;
    codes: number[];
}

interface Tick {
    tm: number;  // timestamp
    vm: number;  // vm state
    s: number[]; // stack
}

interface V8LogProfile {
    code: Code[];
    functions: ProfileFunction[];
    ticks: Tick[];
}

interface CodeCallFrameInfo {
    name: string;
    file?: string; // file path
    line?: number;
    col?: number;
}

type CallFrame = {
    scriptId: number;
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
}
type Node = {
    id: number;
    callFrame: CallFrame;
    children: number[];
}

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

function findBalancePair(str: string, offset: number, pattern: string) {
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

function cleanupInternalName(name: string) {
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

function codeToCallFrameInfo(code: Code): CodeCallFrameInfo {
    if (!code || !code.type) {
        return {
            name: '(unknown)'
        };
    }

    let name = code.name;
    switch (code.type) {
        case 'CPP': {
            if (name[1] === ' ') {
                name = cleanupInternalName(name.slice(2));
            }
            break;
        }

        case 'SHARED_LIB':
            // FIXME: there is no way in cpuprofile to express shared libs at the moment,
            // so represent them as (program) for now
            name = '(LIB) ' + name; // '(program)';
            break;

        case 'JS': {
            // if (kind === "Builtin" || kind == "Ignition" || kind === "Unopt") {
            //     return "JS_IGNITION";
            //   } else if (kind === "Baseline" || kind === "Sparkplug") {
            //     return "JS_SPARKPLUG";
            //   } else if (kind === "Maglev") {
            //     return "JS_MAGLEV";
            //   } else if (kind === "Turboprop") {
            //     return "JS_TURBOPROP";
            //   } else if (kind === "Opt" || kind === "Turbofan") {
            //     return "JS_TURBOFAN";
            //   }
            const spaceIndex = name.lastIndexOf(' ');
            const prelude = name.slice(0, spaceIndex);
            const functionName = prelude.startsWith('get ') ? prelude.slice(4) : prelude;
            const url = name.slice(spaceIndex + 1);
            const locMatch = url.match(/:(\d+):(\d+)/);
            let file = url;
            let line = -1;
            let col = -1;

            if (locMatch) {
                file = url.slice(0, -locMatch[0].length);
                line = parseInt(locMatch[1], 10);
                col = parseInt(locMatch[2], 10);
            }

            return {
                name: functionName,
                file,
                line,
                col
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
                    break;

                case 'BytecodeHandler':
                    name = '(bytecode) ~' + name;
                    break;

                case 'Stub':
                    name = '(stub) ' + name;
                    break;

                case 'Builtin':
                    name = '(builtin) ' + name;
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

    return { name };
}

function createCallFrame(functionName, url = '', lineNumber = -1, columnNumber = -1, scriptId = 0): CallFrame {
    return {
        scriptId,
        functionName,
        url,
        lineNumber,
        columnNumber
    };
}

function createNode(id: number, callFrame: CallFrame): Node {
    return {
        id,
        callFrame,
        children: []
    };
}

export function isV8Log(data: Record<string, unknown>) {
    if (
        data && typeof data === 'object' &&
        Array.isArray(data.code) &&
        Array.isArray(data.functions) &&
        Array.isArray(data.ticks)) {
        return true;
    }

    return false;
}

export function convertV8LogIntoCpuprofile(v8log: V8LogProfile) {
    const scriptIdByUrl = new Map<string, number>([['', 0]]);
    const getScriptIdByUrl = (url: string) => scriptIdByUrl.has(url)
        ? scriptIdByUrl.get(url)
        : scriptIdByUrl.set(url, scriptIdByUrl.size).size - 1;
    const vmStateCallFrames = vmState.map(name =>
        name !== 'js' && name !== 'other' && name !== 'external'
            ? createCallFrame(`(${name})`)
            : null
    );
    const rootCallFrame = createCallFrame('(root)');
    const idleCallFrame = createCallFrame('(idle)');
    const callFrameById = new Map<number, CallFrame>();
    const rootNode = createNode(1, rootCallFrame);
    const rootNodeMap = new Map();
    const nodes = [rootNode];
    const nodesTransition = new Map<number, Map<CallFrame, Node>>([[1, rootNodeMap]]);
    let nodeIdSeed = 1;
    const profile = {
    let lastTm = 0;
        startTime: 0,
        endTime: 0,
        nodes,
        timeDeltas: new Array(v8log.ticks.length),
        samples: new Array(v8log.ticks.length)
    };

    v8log.ticks.sort((a, b) => a.tm - b.tm);

    for (let tickIndex = 0; tickIndex < v8log.ticks.length; tickIndex++) {
        const tick = v8log.ticks[tickIndex];
        let vmStateCallFrame = vmStateCallFrames[tick.vm];
        let currentNode = rootNode;
        let currentNodeMap = rootNodeMap;

        if (vmStateCallFrame === null || tick.vm !== VM_STATE_GC) {
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
                        // not sure was it stands for, but looks like an execution pause
                        if (code.kind === 'BytecodeHandler') {
                            if (code.name === 'Abort.Wide' || code.name === 'Abort.ExtraWide') {
                                continue;
                            }
                        }

                        const { name, file, line, col } = codeToCallFrameInfo(code);
                        callFrame = createCallFrame(name, file, line, col, code.source ? code.source.script : getScriptIdByUrl(file || ''));
                    }

                    callFrameById.set(id, callFrame);
                }

                let nextNode = currentNodeMap.get(callFrame);

                if (nextNode === undefined) {
                    nextNode = createNode(++nodeIdSeed, callFrame);
                    nodes.push(nextNode);
                    currentNodeMap.set(callFrame, nextNode);
                    currentNode.children.push(nextNode.id);
                    nodesTransition.set(nodeIdSeed, currentNodeMap = new Map());
                } else {
                    currentNodeMap = nodesTransition.get(nextNode.id) as Map<CallFrame, Node>;
                }

                currentNode = nextNode;
            }
        }

        // console.log(vmState[tick.vm] || 'unknown', currentNode === rootNode, v8log.code[tick.s[0]], tick);
        if (vmStateCallFrame === null && currentNode === rootNode) {
            vmStateCallFrame = idleCallFrame;
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

        profile.samples[tickIndex] = currentNode.id;
        profile.timeDeltas[tickIndex] = tick.tm - lastTm;

        lastTm = tick.tm;
    }

    profile.endTime =
        lastTm +
        profile.timeDeltas.slice().sort()[profile.timeDeltas.length >> 1];

    return profile;
}
