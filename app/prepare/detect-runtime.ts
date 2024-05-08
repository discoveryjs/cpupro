import { CpuProCategory, CpuProPackage } from './types.js';

type RunTimeCode = keyof typeof runtimes;

const runtimes = {
    chromium: 'Chromium',
    deno: 'Deno',
    edge: 'Edge',
    electron: 'Electron',
    nodejs: 'Node.js',
    unknown: 'Unknown'
} as const;

export function detectRuntime(categories: CpuProCategory[], packages: CpuProPackage[], runtime?: keyof typeof runtimes) {
    const categoriesSet = new Set(categories.map(category => category.name));
    const code: RunTimeCode = runtime || (
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
