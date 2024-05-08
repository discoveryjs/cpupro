/* eslint-env node */

const path = require('path');
const fs = require('fs');
const demosPath = path.join(__dirname, '../app/demo');
const ghpagesDemosPath = path.join(__dirname, '../.gh-pages/demo');

const indexFile = fs.readFileSync(path.join(demosPath, 'index.json'));
const indexData = JSON.parse(indexFile);

fs.mkdirSync(ghpagesDemosPath, { recursive: true });

for (const demo of indexData) {
    fs.cpSync(
        path.join(demosPath, path.basename(demo.url)),
        path.join(ghpagesDemosPath, path.basename(demo.url))
    );
}
