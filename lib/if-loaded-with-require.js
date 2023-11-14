/* eslint-env node */
const { profile } = require('./profiler');

module.exports = function ifLoadedWithRequire(module, callback) {
    // if loaded with --require, start profiling
    if (module.parent && module.parent.id === 'internal/preload') {
        profile().onEnd(callback);
    }
};
