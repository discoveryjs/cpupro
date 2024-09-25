import type { CallFrame, V8LogCode } from './types.js';
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

function callFrameInfoFromNonJsCode(code: V8LogCode): { name: string; lowlevel?: boolean } {
    if (!code || !code.type) {
        return {
            name: '(unknown)'
        };
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
            break;
        }

        case 'SHARED_LIB': {
            // FIXME: there is no way in cpuprofile to express shared libs at the moment,
            // so represent them as (program) for now
            name = '(LIB) ' + name; // '(program)';
            lowlevel = true;
            break;
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

export function createCallFrame(
    functionName: string,
    scriptId = 0,
    lineNumber = -1,
    columnNumber = -1,
    url = ''
): CallFrame {
    return {
        scriptId,
        functionName,
        url,
        lineNumber,
        columnNumber
    };
}

export function createVmStateCallFrames(callFrames: CallFrame[]) {
    const programCallFrame = createCallFrame('(program)');

    return VM_STATES.map(name => {
        if (name !== 'js') {
            // https://github.com/v8/v8/blob/2be84efd933f6e1e29b0c508a1035ed7d13d7127/src/profiler/symbolizer.cc#L34
            const callFrame = name == 'other' || name === 'external' || name === 'logging'
                ? programCallFrame
                : createCallFrame(`(${name})`);

            return callFrames.push(callFrame) - 1;
        }

        return null;
    });
}

export function createFunctionCallFrames(
    callFrames: CallFrame[],
    functions: V8CpuProfileFunction[]
) {
    return functions.map((fn) =>
        callFrames.push(createCallFrame(
            fn.name,
            fn.scriptId,
            fn.line,
            fn.column
        )) - 1
    );
}

function createCodeCallFrames(
    callFrames: CallFrame[],
    codes: V8LogCode[],
    callFrameIndexByFunction: number[]
) {
    return codes.map((code) => {
        // FIXME: ignore Abort.Wide/ExtraWide for now since it too noisy;
        // not sure what it stands for, but looks like an execution pause
        if (code.kind === 'BytecodeHandler') {
            if (code.name === 'Abort.Wide' || code.name === 'Abort.ExtraWide') {
                return null;
            }
        }

        const func = code.func;

        if (func !== undefined) {
            return callFrameIndexByFunction[func];
        }

        const { name, lowlevel } = callFrameInfoFromNonJsCode(code);

        // FIXME: temporary
        if (lowlevel) {
            return null;
        }

        return callFrames.push(createCallFrame(name)) - 1;
    });
}

export function createCallFrames(
    functions: V8CpuProfileFunction[],
    codes: V8LogCode[]
) {
    const callFrames: CallFrame[] = [createCallFrame('(root)')];
    const callFrameIndexByVmState = createVmStateCallFrames(callFrames);
    const callFrameIndexByFunction = createFunctionCallFrames(callFrames, functions);
    const callFrameIndexByCode = createCodeCallFrames(callFrames, codes, callFrameIndexByFunction);

    return {
        callFrames,
        callFrameIndexByVmState,
        callFrameIndexByFunction,
        callFrameIndexByCode
    };
}
