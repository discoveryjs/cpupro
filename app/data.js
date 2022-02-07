/* eslint-env node */
const path = require('path');

const dataFile = './demo.cpuprofile';

module.exports = function() {
    return require('fs')
        .createReadStream(path.join(__dirname, dataFile));
};
