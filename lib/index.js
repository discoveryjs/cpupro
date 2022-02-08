/* eslint-env node */

const ifLoadedWithRequire = require('./if-loaded-with-require');
const createReport = require('./report');

ifLoadedWithRequire(module, profile => {
    profile.report.open();
});

module.exports = {
    ...require('./profiler'),
    createReport
};
