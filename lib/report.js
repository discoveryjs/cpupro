/* eslint-env node */
const os = require('os');
const fs = require('fs');
const path = require('path');
const open = require('open');
const createHtmlRawTextPrinter = require('./html-data-printers/raw-text');
const createHtmlBase64DataPrinter = require('./html-data-printers/base64');
const { defaultFilename } = require('./utils');
const jsonxl = require('./tmp/jsonxl-snapshot9');

const reportTemplateFilename = path.join(__dirname, '../build/report.html');

function createBase64DataPrinter(maxChunkSize, binary, compress) {
    return createHtmlBase64DataPrinter(
        maxChunkSize,
        compress,
        // type
        `discovery/${binary ? 'binary-' : ''}${compress ? 'compressed-' : ''}data-chunk`,
        // onDataChunk
        `discoveryLoader.push(chunk, ${binary}, ${compress})`
    );
}

function createRawTextDataPrinter(maxChunkSize) {
    return createHtmlRawTextPrinter(
        maxChunkSize,
        // type
        'discovery/data-chunk',
        // onDataChunk
        'discoveryLoader.push(chunk, false, false)'
    );
}

module.exports = function createReport(data, filename) {
    let writtenToFile = false;
    const writeToFile = (filepath) => {
        writtenToFile = filepath || defaultFilename('html');

        fs.copyFileSync(reportTemplateFilename, writtenToFile);

        const chunkSize = 1024 * 1024;
        const mainModule = process.mainModule?.filename || '';
        const result = [];
        const printer = typeof data === 'string'
            ? createRawTextDataPrinter(16 * 64 * 1024) // 1Mb
            : createBase64DataPrinter(8 * 64 * 1024, true, true); // 512Kb
        const content = typeof data === 'string' || ArrayBuffer.isView(data)
            ? data
            : jsonxl.encode(data);
        let encodedSize = 0;

        result.push(`\n<script>discoveryLoader.start(${JSON.stringify({
            type: filename ? 'file' : 'build',
            name: filename || (mainModule && path.relative(process.cwd(), mainModule)),
            size: 'byteLength' in content ? content.byteLength : content.length,
            createdAt: Date.now()
        })})</script>`);

        for (let i = 0; i < content.length; i += chunkSize) {
            for (const outChunk of printer.push(content.slice(i, i + chunkSize))) {
                encodedSize += outChunk.length;
                result.push(outChunk);
            }
        }

        for (const outChunk of printer.finish()) {
            encodedSize += outChunk.length;
            result.push(outChunk);
        }

        result.push('\n<script>discoveryLoader.finish(' + encodedSize + ')</script>');

        fs.appendFileSync(writtenToFile, result.join(''));

        return writtenToFile;
    };

    return Object.freeze({
        writeToFileAsync: writeToFile, // FIXME: writeToFile should be async
        writeToFile,
        open() {
            let filepath = writtenToFile;

            if (!filepath || !fs.existsSync(filepath)) {
                filepath = path.join(os.tmpdir(), defaultFilename('html'));
                writeToFile(filepath);
            }

            open(filepath);

            return writtenToFile;
        }
    });
};
