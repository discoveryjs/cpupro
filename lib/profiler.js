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

    const profile = {
        mark(name) {
            meta.marks.push({
                timestamp: performance.now(),
                name
            });
        },
        profileEnd() {
            return profileEnd(name);
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

function profileEnd(name) {
    assertProfileName(name);

    // set generateType 1 to generate a format for cpuprofile
    // to be compatible with most modern devtools
    v8profiler.setGenerateType(1);

    const profile = v8profiler.stopProfiling(v8profileName(name));
    const { startTime, marks } = profileMeta.get(name || '');
    let report = null;

    profile.delete();
    delete profile.delete;

    // normalize marks timestamps
    profile.x_marks = marks;
    for (const mark of marks) {
        mark.timestamp = profile.startTime + Math.round(1000 * (mark.timestamp - startTime));
    }

    return Object.freeze({
        data: profile,
        writeToFile(filepath) {
            jsonExt.stringifyStream(profile)
                .pipe(fs.createWriteStream(filepath || defaultFilename('cpuprofile')));
        },
        writeToFileSync(filepath) {
            fs.writeFileSync(filepath || defaultFilename('cpuprofile'), JSON.stringify(profile));
        },
        writeJsonxlToFileSync(filepath) {
            fs.writeFileSync(filepath || defaultFilename('cpuprofile.jsonxl'), jsonxl.encode(profile));
        },
        openReport() {
            report = report || createReport(profile);
            report.open();
        },
        get report() {
            return report || (report = createReport(profile));
        }
    });
}

module.exports = {
    profile,
    mark,
    profileEnd
};
