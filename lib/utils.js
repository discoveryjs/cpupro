/* eslint-env node */
module.exports = {
    defaultFilename
};

function defaultFilename(ext) {
    const name = new Date().toISOString()
        .replace(/\..+$/, '')
        .replace(/[^\dT ]/g, '')
        .replace(/\D/g, '-');

    return `cpupro-${name}.${ext}`;
}
