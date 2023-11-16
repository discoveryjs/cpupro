/* eslint-env node */
const fs = require('fs');
const jsonExt = require('@discoveryjs/json-ext');
const v8profiler = require('v8-profiler-next');
const { defaultFilename } = require('./utils');
const createReport = require('./report');
const jsonxl = require('./tmp/jsonxl-snapshot9');

const packageName = require('../package.json').name;
const profileMeta = new Map();

function v8profileName(name) {
    return `${packageName}:${name || 'profile'}`;
}

function assertProfileName(name) {
    if (!profileMeta.has(name || '')) {
        throw new Error(`No started CPU profile ${name ? `with name "${name}" ` : ''}is found`);
    }
}

function profile(name) {
    // v8profiler.setSamplingInterval(10);
    if (profileMeta.has(name || '')) {
        return profileMeta.get(name || '').capture;
    }

    const capture = {
        mark(name) {
            meta.marks.push({
                timestamp: performance.now(),
                name
            });
            return capture;
        },
        profileEnd() {
            return profileEnd(name);
        },
        onEnd(callback) {
            meta.onEndCallbacks.push(callback);
            return capture;
        },
        ...Object.fromEntries([
            'writeToFile',
            'writeJsonxlToFile',
            'writeReport',
            'openReport'
        ].map((method) => [method, (...args) => {
            meta.onEndCallbacks.push(result => result[method](...args));
            return capture;
        }]))
    };
    const meta = {
        capture,
        startTime: Date.now(),
        markTime: null,
        marks: [],
        onEndCallbacks: []
    };

    profileMeta.set(name || '', meta);
    process.on('exit', capture.profileEnd);

    v8profiler.startProfiling(v8profileName(name), true);
    meta.markTime = performance.now();

    return capture;
}

function mark(name, profileName) {
    assertProfileName(profileName);

    const { profile } = profileMeta.get(profileName || '');

    profile.mark(name);
}

function profileEnd(name) {
    assertProfileName(name);

    // set generateType 1 to generate a format for cpuprofile
    // to be compatible with most modern devtools
    v8profiler.setGenerateType(1);

    const data = v8profiler.stopProfiling(v8profileName(name));
    const { capture, startTime, marks, onEndCallbacks } = profileMeta.get(name || '');
    let report = null;

    process.off('exit', capture.profileEnd);
    profileMeta.delete(name || '');
    data.delete();
    delete data.delete;

    // normalize marks timestamps
    data.x_marks = marks;
    for (const mark of marks) {
        mark.timestamp = data.startTime + Math.round(1000 * (mark.timestamp - startTime));
    }

    function writeFileAction(destFilename, fn) {
        fn(destFilename);

        return destFilename;
    }

    function getReport() {
        return report || (report = createReport(data));
    }

    const result = Object.freeze({
        data,
        writeToFileAsync(filepath) {
            return writeFileAction(filepath || defaultFilename('cpuprofile'), (destFilename) => {
                jsonExt.stringifyStream(data)
                    .pipe(fs.createWriteStream(destFilename));
            });
        },
        writeToFile(filepath) {
            return writeFileAction(filepath || defaultFilename('cpuprofile'), (destFilename) => {
                fs.writeFileSync(destFilename, JSON.stringify(data));
            });
        },
        writeJsonxlToFile(filepath) {
            return writeFileAction(filepath || defaultFilename('cpuprofile.jsonxl'), (destFilename) => {
                fs.writeFileSync(destFilename, jsonxl.encode(data));
            });
        },
        writeReport(filepath) {
            getReport().writeToFile(filepath);
        },
        openReport() {
            getReport().open();
        },
        get report() {
            return getReport();
        }
    });

    for (const callback of onEndCallbacks) {
        callback(result);
    }

    return result;
}

module.exports = {
    profile,
    mark,
    profileEnd,
    writeToFile: (...args) => profile().writeToFile(...args),
    writeJsonxlToFile: (...args) => profile().writeJsonxlToFile(...args),
    writeReport: (...args) => profile().writeReport(...args),
    openReport: (...args) => profile().openReport(...args)
};
