/* eslint-env node */

module.exports = function repoHealthPath(app) {
    const path = require('path');
    const fs = require('fs');
    const files = JSON.parse(fs.readFileSync(path.join(__dirname, './index.json')));

    for (const demo of files) {
        app.get('/' + demo.url, function(req, res) {
            const filepath = path.join(__dirname, path.basename(demo.url));

            fs.createReadStream(filepath).pipe(res);
        });
    }
};
