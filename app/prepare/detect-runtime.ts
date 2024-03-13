import { CpuProArea, CpuProPackage } from './types.js';

type RunTimeCode = keyof typeof runtimes;

const runtimes = {
    nodejs: 'Node.js',
    chromium: 'Chromium',
    electron: 'Electron',
    unknown: 'Unknown'
} as const;

export function detectRuntime(areas: CpuProArea[], packages: CpuProPackage[]) {
    const areasSet = new Set(areas.map(area => area.name));
    const code: RunTimeCode =
        areasSet.has('electron') ? 'electron'
            : areasSet.has('node') ? 'nodejs'
                : areasSet.has('chrome-extension') ||  packages.find(pkg => /^https?:/.test(pkg.path))
                    ? 'chromium'
                    : 'unknown';

    return {
        engine: 'V8',
        code,
        name: runtimes[code]
    };
}
