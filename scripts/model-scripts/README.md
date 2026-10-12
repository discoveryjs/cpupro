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
