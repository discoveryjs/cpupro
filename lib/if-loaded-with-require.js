/* eslint-env node */
const { profile } = require('./profiler');

module.exports = function ifLoadedWithRequire(module, callback) {
    // if loaded with --require, start profiling
    if (module.parent && module.parent.id === 'internal/preload') {
        const record = profile();

        process.on('exit', () => {
            // the process is going to terminate immediately,
            // all work here must be synchronous
            callback(record.profileEnd());
        });
    }
};
