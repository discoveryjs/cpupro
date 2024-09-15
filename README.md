[![NPM version](https://img.shields.io/npm/v/cpupro.svg)](https://www.npmjs.com/package/cpupro)

# CPUpro

Rethinking of CPU profile analysis and processing. Focused on profiles and logs of any size collected in V8 runtimes: Node.js, Deno and Chromium browsers.

Supported formats:

* [V8 CPU profile](https://nodejs.org/docs/latest/api/cli.html#--cpu-prof) (.cpuprofile)
* [V8 log](https://v8.dev/docs/profile) preprocessed with [--preprocess](https://v8.dev/docs/profile#web-ui-for---prof) (.json)
* [Chromium Performance Profile](https://developer.chrome.com/docs/devtools/performance/reference#save) format (.json)
* [Edge Enhanced Performance Traces](https://learn.microsoft.com/en-us/microsoft-edge/devtools-guide-chromium/experimental-features/share-traces) (.devtools)

> STATUS: MVP
>
> The project is at an early stage of development. Some things have yet to be added and polished. Feel free to create an issue if you found a bug or have an idea.

## Usage

### Scenario #1 – A viewer for CPU profiles

Head to the [viewer on GitHub pages](https://discoveryjs.github.io/cpupro/), open a file in one of supported formats or drop it on the page.

<img width="1267" alt="Demo" src="https://github.com/lahmatiy/cpupro/assets/270491/ea4d54b7-8d37-456a-8db3-628a1da7df3e">

### Scenario #2 – CLI

CLI allows to generate a report (an viewer with embedded data) from a profile file.

To use CLI install `cpupro` globally using `npm install -g cpupro`, or use `npx cpupro`.

- open viewer without embedded data in default browser:
  ```
  cpupro
  ```
- open viewer with `test.cpuprofile` data embedded:
  ```
  cpupro test.cpuprofile
  ```
- open viewer with data embedded from `stdin`:
  ```
  cpupro - <test.cpuprofile
  ```
  ```
  cat test.cpuprofile | cpupro -
  ```
- get usage information:
  ```
  cpupro -h
  ```
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

Main `cpupro` API is similar to [`console.profile()`](https://developer.mozilla.org/en-US/docs/Web/API/console/profile) / [`console.profileEnd()`](https://developer.mozilla.org/en-US/docs/Web/API/console/profileEnd) with an exception that the `profileEnd()` method does nothing but returns API for saving data to a file or generating a report:

```js
const profiler = require('cpupro');

profiler.profile('profileName');

// ... do something

const profile = profiler.profileEnd('profileName');

// write data to .cpuprofile file
profile.writeToFile('./path/to/demo.cpuprofile');
// or write a report (the viewer with embedded data) to file
profile.report.writeToFile('report.html');
// or open the report in a browser
profile.report.open();
```

It is allowed to have several profiles being recorded at once. It's possible to use a reference to profile record API instead of a profile name:

```js
const profiler = require('cpupro');

const profile = profiler.profile();

// ... do something

// end profiling and open a report in a browser
profile.profileEnd().openReport();
```

An alternative approach is to invoke actions such as writeToFile(), writeJsonxlToFile(), writeReport(), and openReport() at the start of profiling. These actions will be executed upon calling profileEnd() or upon process exit if profileEnd() is not explicitly invoked:

```js
const profiler = require('cpupro');

profiler.profile()
  .writeToFile('./path/to/demo.cpuprofile');

// calling profileEnd() is not necessary if a CPU profile should be dumped to a file upon process exit
```

### Scenario #4 – A preload module for Node.js scripts

Record profile, generate report and open it in a browser:

```
node --require cpupro path/to/script.js
```

Record profile, generate report and write into a file:

```
node --require cpupro/file path/to/script.js
# or
node --require cpupro/file/report path/to/script.js
```

Record profile and write it into `.cpuprofile` file:

```
node --require cpupro/file/data path/to/script.js
```

## License

MIT
