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
    const state = createState(1000, 10, 123, 567);
    assert.equal(state.timeStart, 123);
    assert.equal(state.timeEnd, 567);
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

`ruler.test.js` preserves the earlier isolated event-handler checks using the minimal adapter in `test/helpers/ruler.js`. It covers range-manager callbacks and teardown, not layout or actual pointer capture. Real drag, rendering and navigation tests should use Playwright Test as a separate future browser suite; Playwright MCP remains useful for exploratory checks.

`ruler` has no CPUpro profile or line dependencies; labels are numeric by default or supplied by `formatLabel(value, duration)`. `line-ruler` resolves the line and supplies the existing time/byte formatting without a container (`tag: false`). `line-ruler.test.js` checks that delegation preserves props, callbacks and the range manager. This separation leaves the existing `duration`, `timeStart`/`timeEnd`, segment rounding and gesture semantics unchanged.

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