/* eslint-env node */
const os = require('os');
const fs = require('fs');
const path = require('path');
const open = require('open');
const createHtmlDataPrinter = require('./html-data-printer');
const { defaultFilename } = require('./utils');

const reportTemplateFilename = path.join(__dirname, '../build/report.html');

module.exports = function createReport(data) {
    let writtenToFile = false;
    const writeToFile = (filepath) => {
        writtenToFile = filepath || defaultFilename('html');

        fs.copyFileSync(reportTemplateFilename, writtenToFile);

        const chunkSize = 1024 * 1024;
        const printer = createHtmlDataPrinter(chunkSize, 'discovery/data-chunk', 'discoveryLoader.push(chunk)', 'discoveryLoader.finish()');
        const result = [];
        const content = typeof data === 'string'
            ? `{"data":${data}}`
            : JSON.stringify({ data });

        for (let i = 0; i < content.length; i += chunkSize) {
            for (const outChunk of printer.push(content.slice(i, i + chunkSize))) {
                result.push(outChunk);
            }
        }

        for (const outChunk of printer.finish()) {
            result.push(outChunk);
        }

        fs.appendFileSync(writtenToFile, result.join(''));

        return writtenToFile;
    };

    return Object.freeze({
        writeToFile, // FIXME: writeToFile should be async
        writeToFileSync: writeToFile,
        open() {
            let filepath = writtenToFile;

            if (!filepath || !fs.existsSync(filepath)) {
                filepath = path.join(os.tmpdir(), defaultFilename('html'));
                writeToFile(filepath);
            }

            open(filepath);
        }
    });
};
