/* eslint-env node */
const path = require('path');

const dataFile = './demo/demo.cpuprofile';

module.exports = function() {
    return require('fs')
        .createReadStream(path.join(__dirname, dataFile));
};
