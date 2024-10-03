/* eslint-env node */
const path = require('path');
const fs = require('fs');
const wabtPromise = require('wabt')();

const debug = process.argv.includes('--debug');
const files = [
    '../app/prepare/computations/timings.wat'
].map(relpath => path.join(__dirname, relpath));

async function compileWatToWasm() {
    console.log('Compile WAT into WASM');
    console.log('write_debug_names:', debug, (!debug ? '(use --debug option to enable, increases size of wasm files)' : ''));
    console.log();

    const wabt = await wabtPromise;

    for (let filepath of files) {
        process.stdout.write(path.relative(process.cwd(), filepath) + '...');

        const destPath = filepath.replace(/\.wat$/, '.wasm');
        const watFileContent = fs.readFileSync(filepath, 'utf8');
        const wasmModule = wabt.parseWat(filepath, watFileContent);
        const { buffer } = wasmModule.toBinary({
            write_debug_names: debug
        });

        fs.writeFileSync(destPath, buffer);

        console.log('OK');
        console.log('  Written to', path.relative(process.cwd(), destPath), `(${buffer.byteLength} bytes)`);
    }
}

if (module === require.main) {
    compileWatToWasm();
}

module.exports = {
    compileWatToWasm
};
