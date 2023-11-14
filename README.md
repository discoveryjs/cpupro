[![NPM version](https://img.shields.io/npm/v/cpupro.svg)](https://www.npmjs.com/package/cpupro)

# CPU PRO

Rethinking of CPU profile (collected in Node.js or Chromium browsers) analysis.

Supported formats:

* [V8 CPU profile](https://v8.dev/docs/profile) (.cpuprofile)
* [Chromium timeline](https://www.debugbear.com/blog/devtools-performance#recording-a-performance-profile) / [Trace Event](https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/preview) format (.json)

> STATUS: MVP / proof of concept
>
> The project is at an early stage of development. Some things have yet to be added and polished. Feel free to create an issue if you found a bug or have an idea.

<img alt="Demo" src="https://user-images.githubusercontent.com/270491/155012890-18a6d16e-4a17-47f7-a311-d989a3bc4a4c.png">

## Usage

### Scenario #1 – A viewer for CPU profile files

Head to the [viewer on GitHub pages](https://lahmatiy.github.io/cpupro/), open a file in one of supported formats or drop it on the page.

<img width="560" alt="Viewer welcome page" src="https://user-images.githubusercontent.com/270491/155013075-060368a7-0cb3-467d-8b34-8e9a9fcc9ad7.png">

### Scenario #2 – CLI

Install `cpupro` globally using `npm install -g cpupro` or use `npx cpupro`:

- `cpupro` – open viewer without embedded data in default browser
- `cpupro - <test.cpuprofile` or `cat test.cpuprofile | cpupro -` – open viewer with `test.cpuprofile` data embedded
- `cpupro -h` – get usage information:

```
Usage:

    cpupro [filepath] [options]

Options:

    -f, --filename <filename>    Specify a filename for a report; should ends with .htm or .html,
                                 otherwise .html will be added
    -h, --help                   Output usage information
    -n, --no-open                Prevent open a report in browser, the report will be written to file
    -o, --output-dir <path>      Specify an output path for a report (current working dir by default)
    -v, --version                Output version
```

### Scenario #3 – A library for Node.js program

Main `cpupro` API is similar to [`console.profile()`](https://developer.mozilla.org/en-US/docs/Web/API/console/profile) / [`console.profileEnd()`](https://developer.mozilla.org/en-US/docs/Web/API/console/profileEnd) with an exception that the `profileEnd()` method does nothing but return captured data with methods for saving data to a file and generating a report:

```js
const profiler = require('cpupro');

profiler.profile('profileName');

// ... do something

const profile = profiler.profileEnd('profileName');

// write data to .cpuprofile file
profile.writeToFile('./path/to/demo.cpuprofile');
// or write a report (the viewer with embedded data) to file
profile.report.writeToFile('report.html');
// or just open the report in a browser
profile.report.open();
```

It is allowed to have several profiles being collected at once. It's possible to use a reference to profile record API instead of a profile name:

```js
const profiler = require('cpupro');

const profile = profiler.profile();

// ... do something

// end profiling and open a report in a browser
profile.profileEnd().openReport();
```

### Scenario #4 – A preload module for Node.js scripts

Collect data, generate report and open it in a browser:

```
node --require cpupro path/to/script.js
```

Collect data, generate report and write into a file:

```
node --require cpupro/file path/to/script.js
# or
node --require cpupro/file/report path/to/script.js
```

Collect data and write it into `.cpuprofile` file:

```
node --require cpupro/file/data path/to/script.js
```

## License

MIT
