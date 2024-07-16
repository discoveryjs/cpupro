import { CpuProCategory, CpuProPackage, RuntimeCode } from './types.js';

const runtimes = {
    chromium: 'Chromium',
    deno: 'Deno',
    edge: 'Edge',
    electron: 'Electron',
    nodejs: 'Node.js',
    unknown: 'Unknown'
} as const;

export function detectRuntime(categories: CpuProCategory[], packages: CpuProPackage[], runtime?: RuntimeCode) {
    const categoriesSet = new Set(categories.map(category => category.name));
    const code: RuntimeCode = runtime || (
        categoriesSet.has('electron') ? 'electron'
            : categoriesSet.has('deno') ? 'deno'
                : categoriesSet.has('node') ? 'nodejs'
                    : categoriesSet.has('chrome-extension') || packages.find(pkg => pkg.path && /^https?:/.test(pkg.path))
                        ? 'chromium'
                        : 'unknown'
    );

    return {
        engine: 'V8',
        code,
        name: runtimes[code]
    };
}
