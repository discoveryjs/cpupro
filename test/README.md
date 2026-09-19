# Tests

Use Node.js 24 LTS (or a newer supported Node version) and `npm ci`.

```sh
npm test
npm run test:watch
npm test -- population.test.ts
npm test -- --project=wasm
npm test -- -t "preserves span"
npm run test:lint
```

Vitest discovers `*.test.js`, `*.test.ts` and `*.test.mts` next to production modules under `app/` and `lib/`. It does not scan `tmp/`, migration scripts or generated output. No dev server, profile downloads, generated WASM files or git history are required.

## Adding a test

Put the test next to its module. Import runner functions explicitly and use `node:assert/strict`, not `expect` or Vitest's assertion API. Test globals are disabled; ESLint rejects assertion imports from Vitest.

```js
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createState } from './ruler-range.js';

test('restores an exact half-open range', () => {
    const state = createState(1000, 10, { start: 123, end: 567 });
    assert.deepEqual(state.selection, { start: 123, end: 567 });
});
```

Use small deterministic inputs and assert the intended contract. Prefer invariants and concrete values over large snapshots. Assertions about shared objects should use `assert.equal`; array contents should use `assert.deepEqual`.

Fixtures shared by several modules live in `test/fixtures/`; reusable adapters live in `test/helpers/`. Module-specific fixtures can stay beside their test. Nothing in production imports the test directories.

Line consumers (Jora methods and views) use `createLineFixture()` from `test/fixtures/profile.ts`. It returns `{ profile, line, breakdown }` with a real prepared profile, production projection/metric construction, a Base/Viewport/Selection chain and independent requests in one frame. Configure `type`, `origin`, `before`, `after`, `values` and `samples`; do not assemble partial lines with `as ProfileLine` or replace their related fields separately. Sample IDs and weights are kept exactly as supplied; the small structural basis repeats its attribution mappings for extra sample IDs. Use `createProfileFixture()` instead when testing preparation, source maps or actual allocation attribution. Each call creates fresh mutable state; no prepared objects are cached between tests. Benchmark setup belongs outside timed callbacks.

The Vitest VS Code extension can run tests from the editor. Vite handles JS/TS and the project's `.js`/`.mjs` import specifiers; no per-test bundler is needed.

## Computation modes

Every test runs in two isolated Vitest projects, `js` and `wasm`. The test config selects `USE_WASM` without editing production files. The WASM loader compiles the current `.wat` source in memory using the existing `wabt` dependency and supplies the base64 format expected by the computation wrapper.

`inject('useWasm')` and `inject('useUsage')` expose the active mode to TypeScript tests. The default uses usage-local dictionaries. Run the full-dictionary alternative with:

```sh
CPUPRO_TEST_FULL_DICTIONARY=1 npm test
```

## Browser boundaries

The default environment is Node, without jsdom. For profile preparation tests, the root Discovery import is replaced by the small `utils.isArray` adapter in `test/setup/`. Other Discovery imports are not replaced. The parsing-worker entry is replaced by a guard that throws if a fixture tries to start a browser worker. Current profile fixtures use explicit locations and empty source text; parsing and browser-worker execution are not covered by these tests.

`ruler.test.js` uses the minimal adapter in `test/helpers/ruler.js` to check pointer transitions, preview/commit/cancel, external updates, tooltip context and cleanup. It does not replace real layout or pointer-capture checks. Playwright MCP remains useful for those browser checks.

### Ruler API

`ruler` has no CPUpro profile, line or range-manager dependencies. Its props are:

- `range`: a number (`[0, end]`), a pair `[start, end]`, or `{ start, end }`.
- `selection`: `{ start, end } | null` by default; an array of ranges or `null` with `multiple: true`. An empty array stays distinct from `null`. External ranges remain unclipped and unsnapped.
- `segments`: omitted for continuous selection, a positive count for uniform segments, or a strictly increasing array of boundaries covering the complete range. A count of N produces N + 1 boundaries, including both endpoints. Invalid/degenerate segmentation is treated as absent.
- `grid` (default true) and `labels` (`'top'`, `'bottom'`, `'both'`, or false) independently control grid lines and labels. Neither changes snapping.
- `formatLabel(value, range)`: numeric labels by default; receives coordinates and the normalized scale range.
- `details`: rendered with the original data and context extended by `ruler` (the state) and `detail` (the explained interval). Hover without selection explains a segment, or a point on a continuous scale, without changing selection. Selected-range details describe its visible intersection; gaps do not show a selected tooltip.

State contains only `{ range, length, segments, selection }`. Segment boundaries are computed once per render, independent of hover and selection changes. `rangeToSegments(range, boundaries)` is a separate pure function returning half-open segment indices or null, not a state field.

Pointer creation and resize do not collapse the selection. On segmented scales, resize stops at the nearest distinct boundary on the pointer side of the fixed anchor; an off-grid external anchor stays exact. On continuous scales, the gesture minimum is one CSS pixel in scale coordinates, clipped at scale edges. At the anchor, resize retains its current side; crossing the anchor switches sides without an empty selection. Pointer release retains the resulting range. External selections, hover, translation and later layout changes do not apply this minimum.

Callbacks use `onInit({ state, setSelection, name, el }, data, context)`, `onChange(...)`, and `onCommit(...)`. `setSelection` silently updates the existing ruler; changed external values replace and cancel an obsolete gesture, while an equal synchronous echo does not interrupt it. It is safe to call during `onInit` and becomes inert after destruction. An `onInit` cleanup function is called once on destruction. `onChange` reports preview changes, `onCommit` reports an accepted gesture or click reset after capture is released. Escape/pointer cancellation restores the pre-gesture selection through `onChange`, without commit. Destruction releases capture and cleanup without later callbacks. A new drag replaces the selection with one interval even in multiple mode; editing separate members remains future work.

`line-ruler` uses `tag: false`, resolves the line and provides time/byte labels. It defaults to `multiple: true`. Its optional `rangeManager` uses `ranges`, `setRanges()` and `subscribe()` in the same coordinates as the supplied `range`. Viewport rulers pass `scopeViewport()` and `line.range.selection` directly, without a zero-based intermediate view. The wrapper owns the subscription, writes previews, invokes the caller's `onInit`/`onChange`, and combines both cleanup functions. It forwards `range` and `segments` unchanged; only `ruler` normalizes them and constructs boundaries. Until tooltip computations move off bins, the details adapter supplies viewport-local `timeStart`/`timeEnd`, `duration`, and inclusive `segmentStart`/`segmentEnd`. These aliases are not part of ruler state. No-overlap segment slices use `0:0` through the old `segmentEnd + 1` convention. Optimized sample-binning steps are independent of ruler segmentation and remain unchanged.

## Track timeline layout

The [optimization ledger](../specs/track-timeline-optimization-ledger.md) records the algorithm's evolution, rejected experiments, benchmark conditions, V8 findings and current evidence limits.

`track-timeline.test.js` compares layout with an independent duration-first, first-fit reference, including stable ties, corrected short spans, precision boundaries, partial overlaps, nested fast-path fallback and deep nesting. It also checks atomic group publication, pause/resume, cancellation, cached group layouts, visible-track rendering and image invalidation.

After sorting by start, the layout first attempts a linear stack pass for nested or disjoint spans. It checks containment with corrected ends and original duration priority; equal-duration ties retain input order. A crossing or priority inversion abandons this unpublished attempt, but no longer sends the whole group through the general algorithm.

For mixed groups a sweep marks the current span and all active spans whenever it detects a crossing or priority inversion. This crossing core includes the relevant containing ancestors: any higher-priority intersecting dependency of a marked span is also marked. Its first-fit assignment is therefore independent of the unmarked spans. Prefix minima of effective ends and the lowest active priority avoid rescanning ancestors on ordinary nested entry/exit; expiration inside the active stack compacts it in place. Only the core needs the additional duration/end sorts and linked index buffers. Its indices are densely remapped without copying or identifying user objects by reference, and duration ties still use the original input indices.

Once core tracks are assigned, the remaining spans can be placed chronologically, checking only track ends. A remaining span cannot contain a core span or cross any other span; no future start can invalidate its placement. Its active non-core parent's track also gives a lower bound for the first available track. Outputs preserve original span references and start order, including repeated references. Core results are not published as final tracks: publication waits for the complete reconstructed group. A wholly mixed core uses the existing general algorithm directly. If minimum-duration correction collapses numerically to an empty effective interval, the general path preserves the original strict-overlap behavior instead of treating the interval as an ordinary sweep event.

Computation runs in timer tasks with a 12 ms budget, independently of animation frames. Several small groups can finish in one task. A new expanded group is published only when complete; collapsed groups need no layout. Publication follows input order, so a collapsed group behind an unfinished group waits for that predecessor. Already published groups remain visible during expansion, and change height only once its layout completes. Unpublished tracks cause no geometry rebuild or paint. Collapsing a group preserves its iterator and completed tracks; replacing spans or destroying the timeline cancels both queued work and the iterator. Only visible track images are cached, until horizontal coordinates change.

Coordinate preparation and native sorting remain synchronous; the task budget is cooperative, not a hard bound on sorting or canvas painting. The nested path takes O(N log N) including sorting. Mixed groups keep O(N) working storage and the O(N log N + N*M) worst-case bound for N spans and M tracks; a small crossing core avoids applying all general passes to the whole input, but does not establish a universally linear algorithm. Measurements must separate computation time, scheduling delay and painting time; summing frame delays does not measure algorithm cost.

### Rendering detail and labels

Each rendered track lazily acquires a balanced temporal index. Nodes store maximum ends over contiguous ranges of the original start-ordered spans. Offscreen nodes are skipped; a fully visible node whose entire time extent projects to less than one CSS pixel is represented by its first original span. The threshold is evaluated against the current scale, not a fixed set of zoom levels. Large spans and pixel-sized gaps prevent collapse, and isolated point/negative-duration events retain a minimum marker. The index costs O(N) time and storage once per rendered track and survives zoom, pan and collapse; replacement or destruction releases it.

Minimum markers align to the device-pixel grid and subsequent rectangles are clipped against the already painted right edge. This deliberately replaces repeated translucent overdraw with a presence-oriented image at unresolved scales. Original layout, timestamps and selection ranges are unchanged. Hit testing uses a binary search over the actual published rectangles and returns the displayed original representative; zoom reveals the underlying events. Cached track images and hit rectangles are invalidated together on horizontal coordinate or DPR changes.

Invalidating image content does not discard its canvas. Zoom and pan clear and repaint each visible track's existing canvas/context and refill the same representative/position arrays. Bitmap dimensions and the DPR transform are reset only when size or DPR changes. Offscreen tracks are still evicted; input replacement, font loading and destruction retain their existing invalidation behavior. Tests check buffer identity, clearing, refreshed picking and resize. Smoothness measurements should use a frame-paced gesture and tail latencies, not only repeated average redraw times.

Span text metrics retain only full width and first-grapheme-plus-ellipsis width per unique text in the fixed label font. A complete short label can appear below the former 20px cutoff. Truncation never emits an ellipsis without a grapheme and does not split grapheme clusters. Truncated strings and intermediate measurements are not retained. Font loading, data replacement and destruction clear the metrics; font loading also invalidates track images. The viewport-clipped visible rectangle determines the text budget.

Deep zoom is limited by coordinate precision instead of a fixed 1000x factor. The relative ruler starts at the first visible tick while retaining its original time origin. Renderer tests cover progressive detail, offscreen skipping, large spans and gaps, point markers, representative picking, font invalidation, device-pixel alignment and deep zoom. Browser timing must distinguish a cold temporal index from a warm index and must invalidate image caches when measuring redraw cost.

An optional local fixture comparison includes preparation in the timings and checks exact span identity and order on every track. It does not impose machine-dependent timing thresholds or make the normal suite depend on a large trace:

```sh
CPUPRO_TRACK_TIMELINE_FIXTURE=tmp/events-test-fixture.json npm test -- app/views/track-timeline.test.js --project js
```

## Events page preparation

`events.test.js` evaluates the Events page's Jora query through the application method registry and compares it with the previous bulk Jora expression. The page query selects and sorts the small thread list, preserving the original name/count ordering, then calls `eventsTimeline(#.intervals)` once. The specialized method in `app/jora/events.js` takes the ordered threads as its receiver and the selected intervals as an explicit argument; it neither reads page context nor evaluates a nested query. A single event pass per thread computes bounds, display spans and selected overlays without flattened event projections, repeated filters or mapped metric arrays. Bounds intentionally include events excluded from display (including Animation), and overlays do not inherit the positive-time/positive-duration display filter. Output spans retain original event references and repeated occurrences. Missing event/thread lists normalize to empty arrays instead of the old query's `undefined` or `[undefined]` artifacts. No process/result cache is used, so changed process or interval selection is evaluated afresh.

The optional trace test adapts the existing fixture's `start/end` fields to `tm/duration` and verifies complete results against Jora, both with and without selected intervals:

```sh
CPUPRO_TRACK_TIMELINE_FIXTURE=tmp/events-test-fixture.json npm test -- app/pages/events.test.js
```

## Types and production builds

Vitest transforms TypeScript but does not typecheck it. Test files are excluded from the production TypeScript roots. `tsconfig.test.json` includes tests, fixtures, setup and the runner config:

```sh
npm run typecheck
npx tsc -p tsconfig.test.json
```

Both typechecks currently report existing production errors; they are not hidden by the test configuration. Keep test failures and typecheck failures separate.

Discovery's browser assets are explicitly listed in its config, and npm's published file list excludes tests. Adding a colocated test must not require registering it in the app.

## Migration comparisons

`scripts/test-population-breakdowns.cjs --baseline=<revision>` is a separate, optional comparison tool retained from the migration. It is not part of `npm test`. Ordinary regression tests must remain independent of repository history and must define expected behavior themselves.
