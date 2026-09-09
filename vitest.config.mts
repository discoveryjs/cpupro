import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import createWabt from 'wabt';

const useUsage = process.env.CPUPRO_TEST_FULL_DICTIONARY !== '1';

export default defineConfig({
    plugins: [{
        name: 'cpupro-test-assets',
        enforce: 'pre',
        resolveId(source, importer) {
            if (source.endsWith('.wasm') && importer) {
                const filename = resolve(dirname(importer), source);
                if (existsSync(filename.replace(/\.wasm$/, '.wat'))) {
                    return filename;
                }
            }
            if (source.endsWith('/workers/index.js')) {
                return fileURLToPath(new URL('./test/setup/parse-worker.ts', import.meta.url));
            }
            if (source === '@discoveryjs/discovery') {
                return fileURLToPath(new URL('./test/setup/discovery-utils.ts', import.meta.url));
            }
        },
        async load(id) {
            if (id.endsWith('.wasm')) {
                const watFilename = id.replace(/\.wasm$/, '.wat');
                if (existsSync(watFilename)) {
                    this.addWatchFile(watFilename);
                    const wabt = await createWabt();
                    const module = wabt.parseWat(watFilename, readFileSync(watFilename, 'utf8'));
                    try {
                        const { buffer } = module.toBinary({ write_debug_names: false });
                        return `export default ${JSON.stringify(Buffer.from(buffer).toString('base64'))};`;
                    } finally {
                        module.destroy();
                    }
                }
                return `export default ${JSON.stringify(readFileSync(id).toString('base64'))};`;
            }
        }
    }],
    test: {
        environment: 'node',
        globals: false,
        setupFiles: ['./test/setup/node.ts'],
        include: ['app/**/*.test.{js,ts,mts}', 'lib/**/*.test.{js,ts,mts}'],
        projects: [false, true].map(useWasm => ({
            extends: true,
            plugins: [{
                name: 'cpupro-computation-mode',
                enforce: 'pre',
                transform(code, id) {
                    if (id.endsWith('/app/prepare/const.ts')) {
                        return code.replace('export const USE_WASM = true;', `export const USE_WASM = ${useWasm};`);
                    }
                    if (id.endsWith('/app/prepare/computations/sampled-tree-set.ts')) {
                        return code.replace('const useUsage = true;', `const useUsage = ${useUsage};`);
                    }
                }
            }],
            test: {
                name: useWasm ? 'wasm' : 'js',
                provide: { useWasm, useUsage }
            }
        }))
    }
});
