/* eslint-env node */
const ifLoadedWithRequire = require('./if-loaded-with-require');

ifLoadedWithRequire(module, profile => {
    profile.writeToFileSync();
});
