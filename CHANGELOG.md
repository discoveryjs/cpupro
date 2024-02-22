## next

- Report
    - Added "Try demo CPU profile" button when no CPU profile is loaded
    - Adjusted call frame reference computation by omitting line and column when they are not specified or less than zero
    - Added Electron's area
    - Fixed the placement of bundle modules to be placed in the "script" area instead of the "bundle" area
    - Implemented permanent colors and a fixed timeline order for areas and module types
    - Changed flame diagram colors to match area colors and module types
    - Implemented GC nodes reparenting to the script node
    - Improved the display of regular expressions, particularly long ones

## 0.4.0 (2024-01-21)

- Report
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
- Report
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
