import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import createWabt from 'wabt';

const appDir = fileURLToPath(new URL('../app', import.meta.url));
const wabtPromise = createWabt();

// WASM bytes of a module in WAT
export async function compileWat(filepath, writeDebugNames = false) {
    const wabt = await wabtPromise;
    const wasmModule = wabt.parseWat(filepath, fs.readFileSync(filepath, 'utf8'));

    try {
        return wasmModule.toBinary({
            write_debug_names: writeDebugNames
        }).buffer;
    } finally {
        wasmModule.destroy();
    }
}

// Every module of the app is compiled next to its source, a .wat becomes a .wasm
export async function compileWatToWasm(debug = false) {
    console.log('Compile WAT into WASM');
    console.log('write_debug_names:', debug, (!debug ? '(use --debug option to enable, increases size of wasm files)' : ''));
    console.log();

    const files = fs.readdirSync(appDir, { recursive: true })
        .filter(relpath => relpath.endsWith('.wat'))
        .sort()
        .map(relpath => path.join(appDir, relpath));

    for (const filepath of files) {
        process.stdout.write(path.relative(process.cwd(), filepath) + '...');

        const destPath = filepath.replace(/\.wat$/, '.wasm');
        const buffer = await compileWat(filepath, debug);

        fs.writeFileSync(destPath, buffer);

        console.log('OK');
        console.log('  Written to', path.relative(process.cwd(), destPath), `(${buffer.byteLength} bytes)`);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    compileWatToWasm(process.argv.includes('--debug'));
}
