import type { CallFrame, NumericArray, V8LogCode } from './types.js';
import type { V8CpuProfileFunction } from '../../types.js';
import { VM_STATES } from './const.js';

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

function callFrameInfoFromNonJsCode(code: V8LogCode): string | null {
    if (!code || !code.type) {
        return '(unknown)';
    }

    if (code.type === 'JS') {
        // codes of type JS must be processed separately
        throw new Error('Wrong code type: JS');
    }

    let name = code.name;
    let lowlevel = false;

    switch (code.type) {
        case 'CPP': {
            if (name[1] === ' ') {
                name = cleanupInternalName(name.slice(2));
            }
            name = '(CPP) ' + name;
            break;
        }

        case 'SHARED_LIB': {
            name = '(LIB) ' + name;
            lowlevel = true;
            break;
        }

        case 'CODE': {
            switch (code.kind) {
                case 'RegExp':
                    name = 'RegExp: ' + name;
                    break;

                case 'Builtin':
                    if (/IC/.test(name)) {
                        name = '(IC) ' + name;
                        lowlevel = true;
                    } else {
                        name = '(builtin) ' + name;
                        lowlevel = true;
                    }
                    break;

                case 'BytecodeHandler':
                    name = '(bytecode) ' + name;
                    lowlevel = true;
                    break;

                case 'Stub':
                    name = '(stub) ' + name;
                    lowlevel = true;
                    break;

                // legacy?
                case 'LoadIC':
                case 'StoreIC':
                case 'KeyedStoreIC':
                case 'KeyedLoadIC':
                case 'LoadGlobalIC':
                case 'Handler':
                    name = '(IC) ' + name;
                    lowlevel = true;
                    break;
            }

            break;
        }

        default: {
            name = `(${code.type}) ${name}`;
        }
    }

    // FIXME: temporary ignore lowlevel codes, since they need special processing
    if (lowlevel) {
        return null;
    }

    return name;
}

export function createCallFrame(
    functionName: string,
    scriptId = 0,
    lineNumber = -1,
    columnNumber = -1,
    start = -1,
    end = -1,
    url = ''
): CallFrame {
    return {
        scriptId,
        functionName,
        url,
        lineNumber,
        columnNumber,
        start,
        end
    };
}

export function createVmStateCallFrames(callFrames: CallFrame[]) {
    const callFrameIndexByVmState = new Uint32Array(VM_STATES.length);
    const programCallFrameIndex = callFrames.push(createCallFrame('(program)')) - 1;

    for (let i = 0; i < VM_STATES.length; i++) {
        const name = VM_STATES[i];

        if (name !== 'js') {
            // https://github.com/v8/v8/blob/2be84efd933f6e1e29b0c508a1035ed7d13d7127/src/profiler/symbolizer.cc#L34
            callFrameIndexByVmState[i] = name == 'other' || name === 'external'
                ? programCallFrameIndex
                : callFrames.push(createCallFrame(`(${name})`)) - 1;
        }
    }

    return callFrameIndexByVmState;
}

export function createFunctionCallFrames(
    callFrames: CallFrame[],
    functions: V8CpuProfileFunction[]
) {
    const callFrameIndexByFunction = new Uint32Array(functions.length);

    for (let i = 0; i < functions.length; i++) {
        const fn = functions[i];

        callFrameIndexByFunction[i] = callFrames.push(createCallFrame(
            fn.name,
            fn.scriptId,
            fn.line,
            fn.column,
            fn.start,
            fn.end
        )) - 1;
    };

    return callFrameIndexByFunction;
}

function createCodeCallFrames(
    callFrames: CallFrame[],
    codes: V8LogCode[],
    callFrameIndexByFunction: Uint32Array,
    functionsIndexMap: NumericArray | null = null
) {
    const callFrameIndexByCode = new Uint32Array(codes.length);

    for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        const func = code.func;

        if (func !== undefined) {
            const functionIndex = functionsIndexMap !== null
                ? functionsIndexMap[func]
                : func;

            callFrameIndexByCode[i] = callFrameIndexByFunction[functionIndex];
        } else {
            const name = callFrameInfoFromNonJsCode(code);

            if (name !== null) {
                callFrameIndexByCode[i] = callFrames.push(createCallFrame(name)) - 1;
            }
        }
    }

    return callFrameIndexByCode;
}

export function createCallFrames(
    codes: V8LogCode[],
    functions: V8CpuProfileFunction[],
    functionsIndexMap: NumericArray | null = null
) {
    const callFrames: CallFrame[] = [createCallFrame('(root)')];
    const callFrameIndexByVmState = createVmStateCallFrames(callFrames);
    const callFrameIndexByFunction = createFunctionCallFrames(callFrames, functions);
    const callFrameIndexByCode = createCodeCallFrames(callFrames, codes, callFrameIndexByFunction, functionsIndexMap);

    return {
        callFrames,
        callFrameIndexByVmState,
        callFrameIndexByFunction,
        callFrameIndexByCode
    };
}
