# Model scripts

Scripts that analyze traces through the cpupro model. They are run by [`run-model.mjs`](../run-model.mjs), which loads every trace into its own model in an isolated worker, so a script only describes what to compute for one trace.

Requires `npm run build-app` (the runner uses `build/cpupro-model-script.js`) and Node 22.3+ (or 20.16+).

## Quick start

Script mode loads and queries the same prepared model as the web application,
without opening a browser. The following commands run from the repository root;
Node.js 24 LTS is recommended. This is a source-checkout workflow, not a
`cpupro script` CLI subcommand.

```sh
npm ci
npm run build-app
node scripts/run-model.mjs scripts/model-scripts/audit-scripts.mjs app/demo/chromium.jsonxl
```

Replace the demo path with your profile or trace, including `.json.gz` files.
Rebuild after changing preparation, Jora methods or text views; editing an analysis
script does not require rebuilding the model. No web server is needed.

## Running

```
node scripts/run-model.mjs [--jobs <n>] [--option <name[=value]>] <script> <trace> ...
```

- `--jobs` – number of traces processed in parallel; it is limited by an estimated memory budget (about 40 bytes of peak memory per byte of a `.gz` trace), at least one runs always
- `--option` – a string option passed to the script, can be repeated
- the output of every trace is printed in the order of the arguments; a failed trace does not stop the others but makes the exit code 1
- each result has a `# <file>` heading, so redirected stdout is a report, not a single JSON document

## Writing a script

A script is an ES module with a default export. For example, `summary.mjs`:

```js
export default function(model, { file }) {
    return {
        file,
        profiles: model.query(`
            profiles.({ thread: thread.name, tid: thread.tid, scripts: thread.scripts.size() })
        `, model.data, model.getContext())
    };
}
```

```sh
node scripts/run-model.mjs ./summary.mjs /path/to/trace.json.gz
```

The runner calls `default(model, { file, options })` after loading the trace and
awaits its result. Return a string for text output or a serializable value for JSON;
the complete model contains cycles, so project only the fields you need.
`options` contains strings supplied with `--option`, for example `--option thread=7420`.

## Interactive session

Use the standard Node REPL to load a trace once and run repeated queries:

```sh
node --max-old-space-size=16384
```

Enter commands one at a time, waiting for the next `>` prompt after each command:

```js
const { model } = await import('./build/cpupro-model-script.js');
void await model.loadDataFromFile('./app/demo/chromium.jsonxl');
await model.queryChain('profiles.({ thread: thread.name, tid: thread.tid })');
model.query('thread.scripts.size()', model.data.profiles[0]);
void await model.queryChain('profiles').renderToConsole({ view: 'struct', expanded: 1, limit: 5 });
```

Replace the demo path before loading. `model.data` is also available to ordinary
JavaScript. `model.query(query, data, context)` evaluates Jora on explicitly supplied
data; pass `model.data` and `model.getContext()` for model-wide queries. In contrast,
`model.queryChain(query)` starts with the model data and context. `void await` avoids
printing the load/render return value again in the REPL. The trace stays in memory
until you leave with `.exit`.

To write a standalone JSON result from the same session:

```js
const summary = await model.queryChain('profiles.({ thread: thread.name, tid: thread.tid })');
const { writeFile } = await import('node:fs/promises');
await writeFile('./summary.json', JSON.stringify(summary, null, 2));
```

The optional `--max-old-space-size=16384` sets a 16 GiB V8 old-space limit, not a
total process memory limit. Use `--jobs 1` with the runner for large traces and
allow for memory beyond the compressed file size. Avoid `--input-type=module`:
parse workers inherit it, which can break their CommonJS bootstrap. Use `.mjs`
files or the REPL with dynamic `import()` instead.

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
| [`audit-scripts.mjs`](audit-scripts.mjs) | None | Scripts page queries, exclusive source-size checks, compilation identities, and allocation count/byte distributions by type, stage, script and owner |
| [`alive-allocations.mjs`](alive-allocations.mjs) | `thread=<name\|tid>` (required), `limit=<n>` (default 50) | Alive allocations by type and space, plus location-based function metrics with and without compilation allocations |

## Alive allocations example

After building the script model, run:

```sh
node --max-old-space-size=16384 scripts/run-model.mjs \
    --option thread=7420 --option limit=50 \
    scripts/model-scripts/alive-allocations.mjs /path/to/trace.json.gz
```

An exact thread name also works, for example `--option "thread=CrRendererMain"`.
The selection must identify one captured profile. Missing allocation, liveness,
type, space, location or compilation-stage data produces an explicit error.

The example composes Jora queries with `.render()` to return four text tables:

1. All alive allocations by allocation type: count and bytes.
2. All alive allocations by recorded allocation space: count and bytes.
3. Alive allocations by function, using `kind: "location"` and its
     `callFrames.filtered.dict.entries`, exactly as computed by cpupro.
4. The same function metrics after retaining only compilation stage `none`.

`alive` means the recording has no reported GC collection for the allocation;
it is not a reachability analysis. Space is the recorded allocation space, not
a reconstructed space after object promotion. Function self/total bytes come
from the existing location-based trees, including special frames such as compiler
or builtin entries. Total bytes include descendants and must not be summed across
function rows as if they were disjoint allocations.

Compilation exclusion uses the recorded `allocationCompilationStage` attribute,
not inclusive event-size subtraction, frame categories or `compilation.callFrame`.
Thus nested events do not subtract an allocation more than once. Both attribute
tables use `attributeSampleTotals()` on the same filtered population; no new
Jora method or independent aggregation pipeline is needed.

All alive allocations contribute to the metrics and summary totals. `limit` only
limits displayed function rows, sorted by self bytes; type and space tables are
complete. The script temporarily clears line filters, range and viewport, then
restores them in `finally`, including when rendering fails. This also permits
running the example on an already loaded model without leaving its filters changed.

## Scripts audit

```sh
npm run build-app
node --max-old-space-size=16384 scripts/run-model.mjs scripts/model-scripts/audit-scripts.mjs /path/to/trace.json.gz
```

The audit executes the Scripts page's default selection and summary queries for
each distinct thread represented by a CPU profile. It excludes source-map originals
and does not test interactive filters or event-only threads. For repeated profiles
on one thread, only the first profile's allocation population is inspected.

Source bytes estimate flat string storage, not allocations. Compiled bytes sum
exclusive source ranges with observed compiled/optimized states; missing compilation
data is not evidence of zero compilation. `compiledUnavailable` records unavailable
rows separately from the numeric sum. Source partition checks compare the page's
own sizes against independently subtracted nested intervals.

Allocation distributions contain both counts and allocated bytes. `byType` includes
all allocations, while `eventScriptType` provides the full stage/script/type matrix;
filter out stage `none` for compilation-only totals. `allocationOwner` is the owner
of the innermost compilation event, not the allocating JavaScript function for all
runtime allocations. Unresolved and ambiguous identities remain separate buckets.

`ownerMismatchesAssumingIds1ToN` independently scans event intervals `(start, end]`,
assuming allocation IDs are consecutive and begin at 1. It is unavailable when an
event range exceeds that population or the owner attribute is absent. Interpret it
only with zero nesting/range violations; the prepared model does not retain the
original allocation ID vector for this check. Stage comparison also depends on the
existing model diagnostic's coordinate assumptions.

Event-to-function matching uses exact script-relative start/end coordinates, with
the existing default-constructor convention. It also reports disagreements with
cached `event.callFrame`, which is not used by the page's compilation state matcher.
Synthetic runtime functions absent from the source parser can remain unmatched.

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
