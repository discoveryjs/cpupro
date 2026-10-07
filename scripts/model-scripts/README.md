# Model scripts

Scripts that analyze traces through the cpupro model. They are run by [`run-model.mjs`](../run-model.mjs), which loads every trace into its own model in an isolated worker, so a script only describes what to compute for one trace.

Requires `npm run build-app` (the runner uses `build/cpupro-model-script.js`) and Node 22.3+ (or 20.16+).

## Running

```
node scripts/run-model.mjs [--jobs <n>] [--option <name[=value]>] <script> <trace> ...
```

- `--jobs` – number of traces processed in parallel; it is limited by an estimated memory budget (about 40 bytes of peak memory per byte of a `.gz` trace), at least one runs always
- `--option` – a string option passed to the script, can be repeated
- the output of every trace is printed in the order of the arguments; a failed trace does not stop the others but makes the exit code 1

## Writing a script

A script is an ES module with a default export:

```js
export default async function (model, { file, options }) {
    // `model` has the trace loaded, e.g. `model.data.profiles`
    return 'text'; // a string is printed as is, any other value as JSON
}
```

## Scripts

| Script | Options | Description |
| --- | --- | --- |
| [`analyze-signals.mjs`](analyze-signals.mjs) | `thread=<name\|tid>`, `json` | Cross-checks CPU samples, allocations and compilation events: signal presence, integrity checks (`signalIntegrity()`), sample and allocation coverage by compilation events |
