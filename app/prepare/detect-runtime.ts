import { CpuProCategory, CpuProPackage } from './types.js';

type RunTimeCode = keyof typeof runtimes;

const runtimes = {
    nodejs: 'Node.js',
    chromium: 'Chromium',
    electron: 'Electron',
    unknown: 'Unknown'
} as const;

export function detectRuntime(categories: CpuProCategory[], packages: CpuProPackage[]) {
    const categoriesSet = new Set(categories.map(category => category.name));
    const code: RunTimeCode =
        categoriesSet.has('electron') ? 'electron'
            : categoriesSet.has('node') ? 'nodejs'
                : categoriesSet.has('chrome-extension') ||  packages.find(pkg => /^https?:/.test(pkg.path))
                    ? 'chromium'
                    : 'unknown';

    return {
        engine: 'V8',
        code,
        name: runtimes[code]
    };
}
