import type { V8LogCode } from './types.js';
import type { V8CpuProfileDisassemble } from '../../types.js';

function normalizeCompiler(value: string): V8CpuProfileDisassemble['compiler'] {
    switch (value) {
        case 'ignition':
            return 'Ignition';
        case 'turbofan':
        case 'TurboFan':
            return 'Turbofan';
        case 'baseline':
            return 'Sparkplug';
        case 'maglev':
            return 'Maglev';
        // case 'Liftoff (debug)':
        // case 'Liftoff':
        //     return 'Liftoff';
    }

    return `Unknown(${value})`;
}

export function processDisassemble(code: V8LogCode): V8CpuProfileDisassemble | undefined {
    const { disassemble } = code;

    if (!disassemble) {
        return;
    }

    const sections: { header: string; content: string; }[] = [];
    let instructions: string | null = null;
    let compiler: V8CpuProfileDisassemble['compiler'] = 'Ignition';
    let kind = 'INTERPRETER';

    if (disassemble.startsWith('kind = ')) {
        // machine code
        const rawSections = disassemble.split(/\n{2,}/);

        if (rawSections) {
            const prelude = rawSections[0];
            const attrs: Record<string, string> = Object.fromEntries(prelude.split('\n').map(line => line.split(' = ')));

            kind = attrs.kind || 'UNKNOWN';
            compiler = normalizeCompiler(attrs.compiler);
            instructions = parseSection(rawSections[1]).content;

            for (let i = 2; i < rawSections.length; i++) {
                sections.push(parseSection(rawSections[i]));
            }
        }
    } else {
        // interpreter
        const prelude = disassemble.match(/^(.+\s+\d+\n)+/);

        if (prelude) {
            const codeStart = prelude[0].length;
            const codeEnd = disassemble.indexOf('\nConstant pool', codeStart);

            if (codeEnd !== -1) {
                instructions = disassemble.slice(codeStart, codeEnd);
            }
        }
    }

    return {
        kind,
        compiler,
        instructions,
        sections,
        raw: disassemble.trim()
    };
}

function parseSection(text: string) {
    const headerEndOffset = text.indexOf('\n');
    const header = text.slice(0, headerEndOffset !== -1 ? headerEndOffset : text.length);
    const content = text.slice(headerEndOffset + 1);

    return {
        header,
        content
    };
}
