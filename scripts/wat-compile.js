/* eslint-env node */
const path = require('path');
const fs = require('fs');
const wabtPromise = require('wabt')();

const files = [
    '../app/prepare/build-trees.wat',
    '../app/prepare/compute-timings.wat'
].map(relpath => path.join(__dirname, relpath));

async function compileWatToWasm() {
    console.log('Compile WAT into WASM');
    console.log();

    const wabt = await wabtPromise;

    for (let filepath of files) {
        process.stdout.write(path.relative(process.cwd(), filepath) + '...');

        const destPath = filepath.replace(/\.wat$/, '.wasm');
        const watFileContent = fs.readFileSync(filepath, 'utf8');
        const wasmModule = wabt.parseWat(filepath, watFileContent);
        const { buffer } = wasmModule.toBinary({});

        fs.writeFileSync(destPath, buffer);

        console.log('OK');
        console.log('  Written to', path.relative(process.cwd(), destPath));
    }
}

if (module === require.main) {
    compileWatToWasm();
}

module.exports = {
    compileWatToWasm
};
