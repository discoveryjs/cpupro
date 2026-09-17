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
