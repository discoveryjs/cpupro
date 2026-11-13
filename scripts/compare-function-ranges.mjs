#!/usr/bin/env node
// Compares function ranges of parseScriptSourceRanges() with ranges of a syntax tree of @babel/parser
// (test/helpers/babel-function-ranges.ts) over source files, and reports differences and parse failures.
// A dialect is selected by a file name as by a script url: .ts, .tsx and .jsx, JavaScript otherwise.
// Sources of the scripts of a trace are written by scripts/model-scripts/dump-script-sources.mjs.
//
//   node scripts/compare-function-ranges.mjs [--examples <n>] <file or directory> ...

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';

const SOURCE_FILE = /\.([mc]?[jt]sx?)$/;
const FIELDS = [
    'type',
    'name',
    'defaultConstructor',
    'start',
    'end',
    'callFrameStart',
    'callFrameStartLine',
    'callFrameStartColumn'
];

// Node strips types of the TypeScript modules, their imports name the modules with .js
registerHooks({
    resolve(specifier, context, nextResolve) {
        try {
            return nextResolve(specifier, context);
        } catch (error) {
            if (specifier.startsWith('.') && specifier.endsWith('.js')) {
                return nextResolve(specifier.replace(/\.js$/, '.ts'), context);
            }

            throw error;
        }
    }
});

const { parseScriptSourceRanges } = await import('../app/prepare/misc/parse-script-source-ranges.ts');
const { parseFunctionRangesWithBabel } = await import('../test/helpers/babel-function-ranges.ts');

function parseArguments(args) {
    const paths = [];
    let examples = 5;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--examples') {
            examples = Number(args[++i]);
        } else {
            paths.push(args[i]);
        }
    }

    if (paths.length === 0) {
        console.error('Usage: node scripts/compare-function-ranges.mjs [--examples <n>] <file or directory> ...');
        process.exit(2);
    }

    return { paths, examples };
}

function collectFiles(path, files) {
    if (!statSync(path).isDirectory()) {
        files.push(path);
        return files;
    }

    const entries = readdirSync(path, { withFileTypes: true });

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];

        if (entry.isDirectory()) {
            collectFiles(join(path, entry.name), files);
        } else if (SOURCE_FILE.test(entry.name)) {
            files.push(join(path, entry.name));
        }
    }

    return files;
}

function excerpt(source, offset) {
    return JSON.stringify(source.slice(Math.max(0, offset - 50), offset + 50));
}

function compareFile(file, report) {
    const source = readFileSync(file, 'utf8');
    const parsed = parseScriptSourceRanges(source, file, true);
    let expected;

    try {
        expected = parseFunctionRangesWithBabel(source, file);
    } catch (error) {
        report.babelFailed.push(`${file}: ${error.message}`);
        return;
    }

    report.files++;
    report.size += source.length;

    if (!parsed.parsed) {
        report.refused.push(`${file}: ${parsed.error}`);
        return;
    }

    const actual = parsed.ranges;

    report.ranges += expected.length;

    if (actual.length !== expected.length) {
        let i = 0;

        while (i < actual.length && i < expected.length && actual[i].callFrameStart === expected[i].callFrameStart) {
            i++;
        }

        const offset = i < expected.length
            ? expected[i].callFrameStart
            : actual[i].callFrameStart;

        report.countMismatches.push(`${file}: ${actual.length} ranges, babel ${expected.length}; ` +
            `first at ${offset} ${excerpt(source, offset)}`);
        return;
    }

    let same = true;

    for (let i = 0; i < expected.length; i++) {
        for (let j = 0; j < FIELDS.length; j++) {
            const field = FIELDS[j];

            if (actual[i][field] !== expected[i][field]) {
                const list = report.fieldMismatches[field] ??= [];

                same = false;
                list.push(`${file}: ${expected[i].type} at ${expected[i].callFrameStart} ` +
                    `${JSON.stringify(actual[i][field])}, babel ${JSON.stringify(expected[i][field])} ` +
                    excerpt(source, expected[i].callFrameStart));
            }
        }
    }

    if (same) {
        report.same++;
    }
}

function printList(title, list, examples) {
    console.log(`${title}: ${list.length}`);

    for (let i = 0; i < list.length && i < examples; i++) {
        console.log(`  ${list[i]}`);
    }
}

const { paths, examples } = parseArguments(process.argv.slice(2));
const files = [];
const report = {
    files: 0,
    same: 0,
    size: 0,
    ranges: 0,
    fieldMismatches: {},
    countMismatches: [],
    refused: [],
    babelFailed: []
};

for (let i = 0; i < paths.length; i++) {
    collectFiles(paths[i], files);
}

for (let i = 0; i < files.length; i++) {
    compareFile(files[i], report);
}

console.log(`${report.files} files of ${(report.size / 1e6).toFixed(1)}M chars, ${report.ranges} ranges by babel, ` +
    `${report.same} files with the same ranges`);

for (let i = 0; i < FIELDS.length; i++) {
    printList(`different ${FIELDS[i]}`, report.fieldMismatches[FIELDS[i]] ?? [], examples);
}

printList('different numbers of ranges', report.countMismatches, examples);
printList('refused by the parser', report.refused, examples);
printList('not parsed by babel, not compared', report.babelFailed, examples);

const differences = report.countMismatches.length + report.refused.length + Object.keys(report.fieldMismatches).length;

process.exit(differences > 0 ? 1 : 0);
