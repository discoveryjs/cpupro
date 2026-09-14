# Population Filtering

`Population` keeps the original event vectors and aggregates by sample ID. `PopulationFiltered` prepares independent `samples` and `values` vectors for the existing JS/WASM aggregation kernels. Events and sample IDs are different domains: there may be many events for one sample ID.

## Bucket Mask

`samplesMask` has one `Uint32` entry per sample ID, not per event. Each bit represents a sample-domain exclusion reason; zero means accepted by the bucket filters. Event-domain acceptance is applied in addition. Change low-level bits through `updateMask(callback)` and clear them through `resetMask()`. Direct array writes outside the callback do not trigger compilation or notifications.

```ts
filtered.updateMask(mask => {
    mask[sampleId] |= categoryFilterBit;
});
filtered.updateMask(mask => {
    mask[sampleId] &= ~categoryFilterBit;
});
```

The callback evaluates bucket-level predicates. Compilation then maps each original event's sample ID to itself or `sinkId`. Changing ranges does not rerun this callback. Different attribution domains may have different masks even when their filter descriptions are shared.

The hot aggregation kernels retain their current semantics: total sums effective values, count counts nonzero effective values. No filter predicates are evaluated by these kernels.

## Sink

For a public sample domain of size `U`, `sinkId` is `U`. Internal `buffer.samplesCount` and `buffer.samplesTotal` have `U + 1` cells. Public `samplesCount` and `samplesTotal` are stable views of `[0, U)`; projections never consume the sink cell.

`sink` returns `{ count, total }` for masked events that still have a nonzero effective contribution after all range/value constraints. Events outside those constraints contribute zero, including to the sink. This is not a total of every excluded event in the original profile.

`samples` always refers to the internal compiled event-to-bucket vector, including sink IDs. Consumers that inspect events directly must reject IDs outside the public aggregate domain. Historical bounds use the original `Population.samples` instead.

## Value Constraints

All ranges are half-open. They are applied to original data, not to the result of an earlier constraint:

| Method | Meaning |
| --- | --- |
| `setRange(start, end)` | Coordinate range on the original cumulative axis; boundary events contribute only their overlap. |
| `setIndexRange(start, end)` | Original event-index interval; events outside it get zero effective value. |
| `setValueRange(min, max)` | Accept original values in `[min, max)`; this is a predicate, not value clamping. |

Index boundaries must be integers. Coordinate/index endpoints are clamped to the input domain; reversed or non-finite endpoints are rejected. For index/value ranges, `null` is an open bound and two nulls clear the constraint. For the existing coordinate API, either null endpoint resets the range. `resetRange()`, `resetIndexRange()` and `resetValueRange()` reset only their respective constraint, leaving the mask and other constraints in place.

`rangeSamples` counts events with positive coordinate overlap before bucket masking and index/value acceptance; it is null when no coordinate range is active. It is not the filtered count. Effective values and counts still use the existing integer typed-array representation. Fractional storage and cumulative-axis overflow are not redesigned here.

Set/reset order must not affect compiled inputs or aggregates. Base vectors, source topology, and public filtered-vector identities remain unchanged. An effective mask change or changed range constraint recomputes aggregates and notifies subscribers; identical range updates are ignored.

## Current Boundaries

Population updates still propagate eagerly to their subscribed breakdowns. Shared constraints across profiles/threads, cross-line range translation, lazy metrics and viewport/selection separation are separate steps. This module does not merge allocation CPU-stack and location/context sample domains.

Allocation CPU attribution preserves original allocation sizes. When mapping ends before allocation events, the remaining events use the last available CPU sample. Without CPU samples, memline does not create this borrowed call-stack breakdown; this does not implement all historical allocation-only profile formats.
