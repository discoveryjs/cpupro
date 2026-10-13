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

## Inspecting values

The script model includes a text `struct` view. It follows Discovery's structure view,
not Node's object inspector: collapsed previews by default, configurable expansion
depth, bounded collection previews, and model object-marker annotations.

For direct use of the built model:

```js
import { model } from './build/cpupro-model-script.js';

await model.loadDataFromFile('./app/demo/chromium.jsonxl');
await model.queryChain('scopeBreakdown().callFrames.all.dict.entries[:2]')
        .renderToConsole({ view: 'struct', expanded: 2, limit: 10 });
```

Within a runner module, return rendered text instead of printing it directly to
preserve the runner's output ordering:

```js
export default async function(model) {
        const { text } = await model.textView.renderString(
                null, { view: 'struct', expanded: 1 }, model.data, model.getContext()
        );

        return text;
}
```

Supported settings:

- `expanded`: `false` (default), `true` (one level), or a depth. Numeric arrays and
    typed arrays retain compact previews, as in the DOM view.
- `limit` (50), `limitCollapsed` (4), `limitCompactObjectEntries` (0): per-container
    limits for expanded content, collapsed content and objects inside compact previews.
    Omitted entries are counted; `false` disables a limit.
- `maxStringLength` (150), `maxCompactStringLength` (40), `allowedExcessStringLength`
    (10), `maxPropertyLength` (unlimited), `maxCompactPropertyLength` (35): string and
    property-name limits. Strings and ambiguous keys are escaped. `false` disables a limit.
    Truncated strings include the remainder count inside the quotes: `"abc ... N more"`.
- `maxDepth` (64): a text-only safeguard for nested previews, including arrays that
    are still nested when `expanded` is false. The boundary is printed as `[Depth limit]`.
    `false` disables this safeguard.
- `annotations`: Discovery annotation queries/functions, including `{ query, debug }`.
    They receive the same `key`, `index`, `host`, `parent`, and outer `context` as the DOM
    view. Default annotations come from Discovery, including the model's object markers.
    As in HTML struct, entries inside compact previews do not evaluate or display annotations.
    Text, placement and badge/plain style are retained; icons, tooltips, highlighting
    and interactive controls are not rendered.

Objects expose own enumerable string-keyed properties. Arrays, typed arrays and
sets use sequence previews. References have no special labels. Recursive compact
previews stop at an object or sequence ellipsis; shared objects in sibling entries
can appear more than once. Limits apply per container, not
to the total output size. There is no Node-only dependency in the view.

Expansion of an ordinary array checks whether the entire array is numeric,
including entries beyond the preview limit. Collapsed arrays and typed arrays
do not need this scan.

## Diagnostic console output

Script queries provide `consoleLog()` independently of the text views. It calls
Node's `console.log(value, ...args)` and returns the original receiver unchanged:

```js
await model.queryChain('scopeProfile().consoleLog().name');
await model.queryChain('scopeBreakdown().callFrames.all.dict.entries[:2].consoleLog("top entries")');
```

Additional arguments follow the receiver in the console call. Values are passed
directly to the console, without JSON serialization or struct formatting, so cyclic
objects, typed arrays and other Node-inspectable values remain supported. This
method is registered only by the script build, not the browser application.

Diagnostic messages are printed immediately to stdout. Under `run-model.mjs --jobs`,
they can interleave between workers; return final report text from the script to
retain input-file output ordering.

## Checking the script build

```sh
npm run test:script
```

This rebuilds the application and runs native Node tests against the generated ESM
module. The checks cover import without browser globals, query-chain rendering,
`consoleLog()`, and loading/querying a local demo profile. The Build CI workflow
runs these tests after its full build and Vitest tests, without rebuilding.
To check an existing build without rebuilding:

```sh
node --test scripts/model-script.test.mjs
```

## Scripts

| Script | Options | Description |
| --- | --- | --- |
| [`analyze-signals.mjs`](analyze-signals.mjs) | `thread=<name\|tid>`, `json` | Independent scopes, windows and event statistics from [`app/signals.js`](../../app/signals.js); population distributions from `sampleDistribution()` and optional coverage from `samplesByCompilation()` |

## Analysis questions

The signals page and this report distinguish population measurements from cross-signal attribution.
Each population is optional; event-only threads remain separate scopes, and no records is an explicit state.

| Question | Required records | Evidence |
| --- | --- | --- |
| What was recorded, and over which boundaries? | Any | Counts and known time/ID windows; absent coordinates stay absent |
| Which categories dominate count versus volume? | CPU or allocations | Model category counts alongside interval sums or allocated bytes |
| Are totals driven by many small records or a few large ones? | CPU or allocations | Half-open size/interval ranges, with count and value shares |
| Where does a selected category's activity concentrate? | CPU or allocations | 500-bin histogram over sample-start time or allocation index; selectable count/value, a shared all-category maximum per quantity and interval details |
| What compilation work was recorded independently of sampling? | Events | Event-type counts, timed/instant/incomplete records, inclusive durations and timestamps |
| How much allocation recording lies outside the CPU window? | CPU + allocations + usable mapping | Boundary counts, explicitly assuming allocation IDs `1..N` |
| Which sample categories lie inside/outside events, and in which stages? | CPU + events, or allocations + recorded stage | Optional coverage and event/category matrix with explicit denominators |

The time histogram assigns the full interval value to its sample-start bin; it is not a
continuous CPU-occupancy chart. Allocation indices are ordinal positions, not elapsed time
or verified original allocation IDs. Event durations are inclusive and can overlap.

CPU coverage assigns sample timestamps to the innermost timed event using `[start, end)`;
crossing events make this attribution unavailable. Allocation coverage uses the recorded
compilation-stage attribute, not an independent reconstruction of event ownership.
Allocation boundary counts assume IDs `1..N` and are unavailable when mapped IDs exceed
the population. Categories come from each population's category tree, not from a separate
classification of frame names or kinds. Missing category data remains unknown.
