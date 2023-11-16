/* eslint-env node */

const fs = require('fs');
const path = require('path');
const cli = require('clap');
const open = require('open');
const createReport = require('./report');
const { defaultFilename } = require('./utils');
const appFilename = path.join(__dirname, '../build/app.html');

function readFromStream(stream, process) {
    const chunks = [];

    stream
        .on('data', function(chunk) {
            chunks.push(chunk);
        })
        .on('end', function() {
            process(Buffer.concat(chunks));
        });
}

// define command
const command = cli.command('cpupro [filepath]')
    .version(require('../package.json').version)
    .option('-o, --output-dir <path>', 'Specify an output path for a report (current working dir is by default)')
    .option('-f, --filename <filename>', 'Specify a filename for a report; should ends with .htm or .html, otherwise .html will be added')
    .option('-n, --no-open', 'Prevent open a report in browser, the report will be written to file')
    .action(function({ args, options }) {
        const cpuprofileFile = args[0];

        if (!cpuprofileFile) {
            open(appFilename);
            process.exit();
        }

        options = {
            ...options,
            cpuprofileFile
        };

        const inputStream = cpuprofileFile !== '-'
            ? fs.createReadStream(cpuprofileFile)
            : process.stdin;

        readFromStream(inputStream, (data) => {
            const report = createReport(data, cpuprofileFile);

            if (!options.open || options.outputDir || options.filename) {
                const filename = options.filename || defaultFilename('html');
                const filepath = path.join(
                    options.outputDir || process.cwd(),
                    /\.html?$/.test(filename) ? filename : filename + '.html'
                );

                // ensure path to file exists
                fs.mkdirSync(path.dirname(filepath), { recursive: true });

                // write report to file
                report.writeToFile(filepath);
                console.log(`Report written to ${filepath}`);
            }

            if (options.open) {
                report.open();
            }
        });
    });

module.exports = {
    run: command.run.bind(command),
    isCliError(err) {
        return err instanceof cli.Error;
    }
};
