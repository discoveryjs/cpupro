#!/usr/bin/env node
// Runs a script module over traces, every trace in an isolated worker with its own model.
// Requires `npm run build-app` first. A script module exports
// `default(model, { file, options })` and returns a string (printed as is) or data (JSON).
//
//   node scripts/run-model.mjs [--jobs <n>] [--option <name=value>] <script> <trace> ...

import { existsSync, statSync } from 'node:fs';
import { totalmem } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = 'Usage: node scripts/run-model.mjs [--jobs <n>] [--option <name=value>] ' +
    '<script> <trace> ...';
const modelScriptUrl = new URL('../build/cpupro-model-script.js', import.meta.url);
const workerUrl = new URL('./run-model-worker.mjs', import.meta.url);

// Peak RSS of the largest known trace: ~7.5 GB for a 196 MB gz
const PEAK_BYTES_PER_TRACE_BYTE = 40;
const MEMORY_SHARE = 0.75;

function parseArguments(args) {
    const options = {};
    const positional = [];
    let jobs = 1;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--jobs') {
            jobs = Number(args[++i]);
        } else if (args[i] === '--option') {
            const [name, ...value] = (args[++i] ?? '').split('=');

            options[name] = value.join('=');
        } else {
            positional.push(args[i]);
        }
    }

    const [script, ...files] = positional;

    return { script, files, options, jobs };
}

function runInWorker({ script, file, options }) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(workerUrl, {
            workerData: {
                modelScriptUrl: modelScriptUrl.href,
                scriptUrl: pathToFileURL(script).href,
                file,
                options
            }
        });

        worker.once('message', message => {
            worker.terminate();
            resolve(message);
        });
        worker.once('error', reject);
        worker.once('exit', code => reject(new Error(`Worker exited with code ${code}`)));
    });
}

function formatResult(result) {
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

// Starts jobs while the estimated peak memory fits the budget; at least one always runs
async function runAll({ script, files, options, jobs }) {
    const budget = totalmem() * MEMORY_SHARE;
    const sizes = files.map(file => statSync(file).size * PEAK_BYTES_PER_TRACE_BYTE);
    const outputs = new Array(files.length);
    const running = new Set();
    let reserved = 0;
    let next = 0;
    let printed = 0;
    let failed = false;

    function printReady() {
        for (; printed < files.length && outputs[printed] !== undefined; printed++) {
            console.log(outputs[printed]);
        }
    }

    function canStart() {
        return next < files.length && running.size < jobs &&
            (running.size === 0 || reserved + sizes[next] <= budget);
    }

    function start(index) {
        const task = runInWorker({ script, file: files[index], options })
            .then(({ result }) => `# ${files[index]}\n${formatResult(result)}`)
            .catch(error => {
                failed = true;

                return `# ${files[index]}\nERROR: ${error.stack ?? error.message}`;
            })
            .then(output => {
                outputs[index] = output;
                reserved -= sizes[index];
                running.delete(task);
                printReady();
            });

        reserved += sizes[index];
        running.add(task);
    }

    while (next < files.length || running.size > 0) {
        while (canStart()) {
            start(next++);
        }

        await Promise.race(running);
    }

    return !failed;
}

async function main() {
    const args = parseArguments(process.argv.slice(2));

    if (!args.script || args.files.length === 0 || !(args.jobs >= 1)) {
        console.error(USAGE);
        process.exit(1);
    }

    if (!existsSync(fileURLToPath(modelScriptUrl))) {
        console.error('build/cpupro-model-script.js is missing, run `npm run build-app` first');
        process.exit(1);
    }

    const missing = [args.script, ...args.files].filter(path => !existsSync(path));

    if (missing.length > 0) {
        console.error(`File not found: ${missing.join(', ')}`);
        process.exit(1);
    }

    const ok = await runAll({
        ...args,
        script: resolve(args.script),
        files: args.files.map(file => resolve(file))
    });

    process.exit(ok ? 0 : 1);
}

await main();
