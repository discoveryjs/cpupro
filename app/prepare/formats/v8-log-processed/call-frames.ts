import { parseJsName } from './functions.js';
import { VM_STATES } from './const.js';
import { CallFrame, Code, CodeCallFrameInfo, Script, V8LogProfile } from './types.js';

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

function callFrameInfoFromCode(code: Code, scripts: Script[]): CodeCallFrameInfo {
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

export function createCallFrame(
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

export function createVmCallFrames(callFrames: CallFrame[]) {
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

function createCodeCallFrames(callFrames: CallFrame[], v8log: V8LogProfile) {
    const scriptIdByUrl = new Map<string, number>([['', 0]]);
    const getScriptIdByUrl = (url: string) => scriptIdByUrl.has(url)
        ? scriptIdByUrl.get(url)
        : scriptIdByUrl.set(url, scriptIdByUrl.size).size - 1;

    const funcToCallFrame: (number | null)[] = Array.from({ length: v8log.functions.length }, () => null);

    return v8log.code.map((code) => {
        // FIXME: ignore Abort.Wide/ExtraWide for now since it too noisy;
        // not sure what it stands for, but looks like an execution pause
        if (code.kind === 'BytecodeHandler') {
            if (code.name === 'Abort.Wide' || code.name === 'Abort.ExtraWide') {
                return null;
            }
        }

        const func = code.func;

        if (func !== undefined && funcToCallFrame[func] !== null) {
            return funcToCallFrame[func];
        }

        const { name, file, line, column, lowlevel } = callFrameInfoFromCode(code, v8log.scripts);
        const callFrame = lowlevel ? null : createCallFrame(
            name,
            file,
            line,
            column,
            code.source ? code.source.script : getScriptIdByUrl(file || ''),
            typeof code.func === 'number' ? code.func : null
        );
        const callFrameIndex = callFrame !== null
            ? callFrames.push(callFrame) - 1
            : null;

        if (func !== undefined) {
            funcToCallFrame[func] = callFrameIndex;
        }

        return callFrameIndex;
    });
}

export function createLogCallFrames(v8log: V8LogProfile) {
    const callFrames: CallFrame[] = [createCallFrame('(root)')];
    const callFrameIndexByVmState = createVmCallFrames(callFrames);
    const callFrameIndexByCode = createCodeCallFrames(callFrames, v8log);

    return {
        callFrames,
        callFrameIndexByVmState,
        callFrameIndexByCode
    };
}
