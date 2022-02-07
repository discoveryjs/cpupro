/* eslint-env node */
const fs = require('fs');
const os = require('os');
const path = require('path');
const open = require('open');
const jsonExt = require('@discoveryjs/json-ext');
const v8profiler = require('v8-profiler-next');
const createHtmlDataPrinter = require('./html-data-printer');

const packageName = 'cpuprofile-discovery';
const profileMeta = new Map();

function v8profileName(name) {
    return `${packageName}:${name || 'profile'}`;
}

function assertProfileName(name) {
    if (!profileMeta.has(name || '')) {
        throw new Error(`No started CPU profile ${name ? `with name "${name}" ` : ''}is found`);
    }
}

function defaultFilename(ext) {
    const name = new Date().toISOString()
        .replace(/\..+$/, '')
        .replace(/[^\dT ]/g, '')
        .replace(/\D/g, '-');

    return `cpu-${name}.${ext}`;
}

function start(name) {
    // set generateType 1 to generate a format for cpuprofile
    // to be compatible with most modern devtools
    v8profiler.setGenerateType(1);

    const profile = {
        mark(name) {
            meta.marks.push({
                timestamp: Math.round(1000 * (performance.now() - meta.markTime)),
                name
            });
        },
        stop() {
            return stop(name);
        }
    };
    const meta = {
        profile,
        startTime: Date.now(),
        markTime: null,
        marks: []
    };

    profileMeta.set(name || '', meta);

    v8profiler.startProfiling(v8profileName(name), true);
    meta.markTime = performance.now();

    return profile;
}

function mark(name, profileName) {
    assertProfileName(profileName);

    const { profile } = profileMeta.get(profileName || '');

    profile.mark(name);
}

function createReport(data) {
    let writtenToFile = false;
    const writeToFile = (filepath) => {
        writtenToFile = filepath || defaultFilename('html');

        fs.copyFileSync(path.join(__dirname, '../build/index.html'), writtenToFile);

        const chunkSize = 1024 * 1024;
        const printer = createHtmlDataPrinter(chunkSize, 'discovery/data-chunk', 'discoveryLoader.push(chunk)', 'discoveryLoader.finish()');
        const result = [];
        const content = JSON.stringify({ data });

        for (let i = 0; i < content.length; i += chunkSize) {
            for (const outChunk of printer.push(content.slice(i, i + chunkSize))) {
                result.push(outChunk);
            }
        }

        for (const outChunk of printer.finish()) {
            result.push(outChunk);
        }

        fs.appendFileSync(writtenToFile, result.join(''));
    };

    return Object.freeze({
        writeToFile,
        open() {
            let filepath = writtenToFile;

            if (!filepath || !fs.existsSync(filepath)) {
                filepath = path.join(os.tmpdir(), defaultFilename('html'));
                writeToFile(filepath);
            }

            open(filepath);
        }
    });
}

function stop(name) {
    assertProfileName(name);

    const profile = v8profiler.stopProfiling(v8profileName(name));
    const { startTime, marks } = profileMeta.get(name || '');
    let report = null;

    profile.delete();
    delete profile.delete;

    // v8-profiler-next might return strange timestamps, aling it to user's time
    profile.endTime = startTime + (profile.endTime - profile.startTime);
    profile.startTime = startTime;
    profile.x_marks = marks;

    return Object.freeze({
        data: profile,
        writeToFile(filepath) {
            jsonExt.stringifyStream(profile)
                .pipe(fs.createWriteStream(filepath || defaultFilename('cpuprofile')));
        },
        writeToFileSync(filepath) {
            fs.writeFileSync(filepath || defaultFilename('cpuprofile'), JSON.stringify(profile));
        },
        openReport() {
            report = report || createReport(profile);
            report.open();
        },
        report() {
            return report || (report = createReport(profile));
        }
    });
}

module.exports = {
    start,
    mark,
    stop
};

// if loaded with --require, start profiling.
if (module.parent && module.parent.id === 'internal/preload') {
    const profile = start();

    process.on('exit', () => {
        // the process is going to terminate imminently. All work here needs to be synchronous.
        profile.stop().report().open(); // writeToFile('test.json');
    });
}
