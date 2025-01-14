## next

- Viewer
    - Added hotness icon for call frames with codes

## 0.6.0 (2025-01-14)

- Viewer
    - Changed terminology in accordance with that adopted in V8; the main term is now **call frame** (JS/Wasm function, RegExp, VM state, native handler, etc.) instead of "function"
    - Added "All call frames," "All modules," and "All packages" pages, which display entries even if they have no samples (when a profile provides data about compiled functions, such as a V8 log)
    - Added an option to consolidate call frames (a "Consolidate call frames" checkbox, checked by default) to the "Nested call sites" tree on the call frame page
    - Added call frame consolidation in a call frame's nested calls flame chart on the call frame page
    - Added call tree updates on filter changes on the call frame page
    - Added a `kind` property for call frames, which can be `script`, `function`, `regexp`, `vm-state`, or `root`
    - Reworked tables on the `category`, `package`, and `module` pages to include records with no samples and show the number of nested subjects (e.g., modules or call frames for a package) as `sampled / all`
    - Reworked the data model in preparation for multi-profile analysis and comparison
    - Reworked profile data preprocessing and initial profile computations
    - Introduced a shared dictionary for call frames, scripts, modules, packages, etc., to be used across a set of profiles
    - Introduced an optional call frame positions tree and related structures for source code position precision timings
    - Improved parsing of function names and URLs during the conversion of preprocessed V8 logs into cpuprofile
    - Changed line and column numbers to be zero-based during the conversion of preprocessed V8 logs into cpuprofile
    - Limited the display of very long regular expressions in the function page header to the first 256 characters
    - Replaced the `engine` category with `compilation` (covering parsers and compilers) and `blocking` (atomic waits) categories
    - Added a `devtools` category for scripts injected by a runtime for debugging purposes, such as those added by VS Code for scripts run from the "Run and Debug" panel
    - Fixed processing of `v8/gc` call frames that appear when Node.js is run with `--expose-gc` and `global.gc()` is invoked (added to `internals`)
    - Various fixes and improvements

## 0.5.1 (2024-05-10)

- Viewer
    - Added transformation from `parent` to `children` for call tree nodes for `.cpuprofile` files if needed (fixes #5)
    - Implemented exclusion of ending no-sample time. For certain profiles, the time from the last sample until `endTime` can be significant, indicating the conclusion of the profiling session or adjustments from excluding idle samples at the end. This time is now excluded from the `Profiling time` which used for computing time percentages
    - Fixed double rendering of the page after the profile data is loaded

## 0.5.0 (2024-05-09)

- Viewer
    - Changed the terminology: replaced "area" with "category"
    - Formats
        - Added support for [Edge Enhanced Performance Traces](https://learn.microsoft.com/en-us/microsoft-edge/devtools-guide-chromium/experimental-features/share-traces)
        - Added support for [V8 log](https://v8.dev/docs/profile) preprocessed with [`--preprocess`](https://v8.dev/docs/profile#web-ui-for---prof)
        - Fixed the extraction of a CPU profile from Chrome tracing when it contains several profiles
    - Computations
        - Reworked the computations on profile loading from scratch with performance and memory usage in mind, achieving a 2-10 times speed increase and reduced memory consumption
        - Implemented GC nodes reparenting to the script node
        - Fixed the placement of bundle modules to be placed in the "script" category instead of the "bundle" category
        - Changed the handling of negative time deltas, they are now corrected by rearranging instead of being ignored
        - Resolved the issue with shortening paths to scripts when `webpack/runtime` is present in the CPU profile
        - Adjusted call frame reference computation by omitting line and column when they are not specified or less than zero
    - Runtimes & registries
        - Added Deno detection
        - Added Electron detection
        - Added detection for CDNs and registries: JSR, deno.land, jsdelivr, unpkg, esm.sh, esm.run, jspm, and skypack
    - Redesigned welcome page, added "Try an example" buttons
    - Reworked the layout and UX of the main page
        - Implemented permanent colors and a fixed timeline order for areas and module types
    - Improved the display of regular expressions, particularly long ones
    - Reworked subject pages, each page now includes:
        - A timeline that not only displays self time but also nested time, with the distribution of nested time by categories
        - A section "Nested time distribution"
        - A basic flamechart displaying all frames related to the current subject as root frames
    - Timeline
        - Added the capability to select a range
        - Added a tooltip that provides expanded details on a range
    - Flamechart
        - Added vertical scrolling locking when not activated
        - Added a detailed information block for the selected or zoomed frame
        - Added the capability to select frames
        - Improved performance and reliability
        - Changed colors to match category colors and module types

## 0.4.0 (2024-01-21)

- Viewer
    - Extracted regular expression into a separate area `regexp`
    - Fixed edge cases when `scriptId` is not a number
    - Added ancestor call sites on a function page
    - Added function grouping on a function page (enabled by default)
    - Added timeline split by areas on default page
    - Improved function subtree displaying
    - Fixed processing of evaled functions (call frames with `evalmachine` prefixes)
- CLI:
    - Added support to load jsonxl files
- API:
    - Profile (result of `profileEnd()`):
        - Renamed methods:
            - `writeToFile()` -> `writeToFileAsync()`
            - `writeToFileSync()` -> `writeToFile()`
            - `writeJsonxlToFileSync()` -> `writeJsonxlToFile()`
        - Changed `writeToFileAsync()`, `writeToFile()` and `writeJsonxlToFile()` methods to return a destination file path
        - Added `writeReport()` method as alias to `report.writeToFile()`
    - `profileEnd().report`
        - Renamed `writeToFile()` -> `writeToFileAsync()` and `writeToFileSync()` -> `writeToFile()` (however, at the moment both are sync)
        - Changed `open()` method to return a destination file path
    - Capture (result of `profile()`)
        - Added `onEnd(callback)` method to add a callback to call once capturing is finished, a callback can take a profiling result argument
        - Added `writeToFile()`, `writeJsonxlToFile()`, `writeReport()` and `openReport()` methods to call corresponding methods one capturing is finished
    - Changed `profile()` to return an active capturing for a name if any instead of creating a new one
    - Changed `profile()` to subscribe on process exit to end profiling (`process.on('exit', () => profileEnd())`)
    - Added `writeToFile()`, `writeJsonxlToFile()`, `writeReport()` and `openReport()` methods that starts `profile()` and call a corresponding method, i.e. `writeReport()` is the same as `profile().writeReport()`

## 0.3.0 (2023-04-06)

- Used jsonxl binary and gzip encodings for data on report generating, which allow to produce a report much faster and much smaller (up to 50 times) in size
- Added `writeJsonxlToFileSync()` method to profile
- Added `build/*.html` and `package.json` to exports
- Viewer
    - Bumped `discoveryjs` to `1.0.0-beta.73`
    - Enabled [embed API](https://github.com/discoveryjs/discovery/blob/master/docs/embed.md) for integrations
    - Rework `flamechart` for performance and reliability, it's a little more compact
    - Added badges for function references
    - Updated segments timeline
    - Fixed Windows path processing
    - New page badges

## 0.2.1 (2022-04-20)

- Added count badges and tweaked numeric captions
- Fixed processing of profiles when call frame `scriptId` is a non-numeric string
- Reworked `flamechart` view to improve performance especially on large datasets (eliminated double "renders" in some cases, a lot of unnecessary computations and other optimisations)
- Changed behaviour in `flamechart` when click on already selected frame to select previously selected frame with a lower depth
- Fixed `flamechart`'s view height updating when stack depth is growing on zoom
- Bumped `discoveryjs` to [1.0.0-beta.65](https://github.com/discoveryjs/discovery/releases/tag/v1.0.0-beta.65)

## 0.2.0 (2022-02-21)

- Added support for Chromium Developer Tools profile format (Trace Event Format)
- Added flame chart on index page
- Fixed time deltas processing
- Fixed total time computation for areas, packages, modules and functions
- Fixed module path processing
- Reworked aggregations for areas, packages, modules and functions

## 0.1.1 (2022-02-07)

- Added missed `bin` field
- Renamed profile recording method `end()` into `profileEnd()` for less confussion
- Fixed a crash in viewer when an element in `nodes` doesn't contain a `children` field, e.g. when DevTools protocol is used
- Fixed file module path normalization in viewer
- Removed modification of `startTime` and `endTime` in recorded profile
- Exposed `createReport()` method

## 0.1.0 (2022-02-07)

- Initial release
