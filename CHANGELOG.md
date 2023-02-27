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
