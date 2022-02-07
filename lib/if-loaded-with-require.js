/* eslint-env node */
const { start } = require('./profiler');

module.exports = function ifLoadedWithRequire(module, callback) {
    // if loaded with --require, start profiling
    if (module.parent && module.parent.id === 'internal/preload') {
        const profile = start();

        process.on('exit', () => {
            // the process is going to terminate imminently,
            // all work here needs to be synchronous
            callback(profile.stop());
        });
    }
};
