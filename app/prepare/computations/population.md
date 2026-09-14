# Population Filtering

`Population` keeps the original event vectors and aggregates by sample ID. `PopulationFiltered` prepares independent `samples` and `values` vectors for the existing JS/WASM aggregation kernels. Events and sample IDs are different domains: there may be many events for one sample ID.

## Attribute Filters

Line construction creates an empty `FilterSet`. It contains only settings, their subscriptions and batched notifications. It knows nothing about populations, attribution sources or predicate compilation. Population and breakdown constructors do not register or connect filters.

Preparation uses maps of attribute and breakdown factories. Each factory owns availability checks, settings identity/options, domain, size and `compile(settings)`. It returns a `FilterComputation` or `null`. The common pass groups breakdowns by population, calls each breakdown factory with that group, then merges settings by key and supplies the retained settings object to compilation. Attribute computations target the line's populations; a breakdown-group computation targets its population once. Attributes are visited in input order, with a handler lookup by name; attributes without a handler are skipped. Adding a supported filter requires its factory and map entry, not another branch in `prepareLineFilters()`.

Profile assembly first collects the lines and their breakdowns, including source-mapped results. `createSourceMappedBreakdown()` returns a result without adding it to the line; the caller owns that collection. After this stage, assembly calls `prepareLineFilters(line)` separately for each line.

`prepareLineFilters()` collects supported attributes from the completed inputs, extends the settings and installs one update subscription. Attribute-specific creation and compilation functions live in `../lines/filters/`. The integration function retains a fixed computation list, not a dynamic consumer registry. `SetAttributeFilter.addOptions()` extends available values without replacing mode or selected keys. To integrate subsequently added attributes or breakdowns, stop the previous subscription using the returned function and run preparation again; stopping updates leaves the last computed results intact. This explicit preparation step is not a live construction framework.

Category values are collected locally per population and united in the line's settings:

| Setting | Values and predicate basis |
| --- | --- |
| `category` | All attribution sources of each population, including values introduced by source resolution. CPU-stack and allocation-location populations keep their own lookups and contribute to one option set. |
| `allocationLiveness`, `allocationSpace` | Allocation-event attributes, shared between both memline attribution paths. |

There is one category condition per population, not one per representation. A sample may have categories from several attributions: include accepts it if any category is selected, and exclude rejects it if any category is selected. Attribution lookups are kept local; a category available only in another population does not match this one. Breakdown order and kind do not affect acceptance. A shared executor applies the resulting participation to all its representations. Matching category selections across the two memline populations still need not accept identical events. Package/module/function conditions and profile-level aggregation are not implemented here.

The integration step prepares `{ key, domain, size, accepts }` results only when the settings revision changes. `null` acceptance means unrestricted. Event-filter results are reused by both executors. Category compilation snapshots only selected keys, and space compilation uses an option-sized table; no new event-sized vector is allocated. Each executor still encodes its own sample/sink destinations. `PopulationFilter.set()` consumes these results without accessing settings, and ignores identical result objects. One settings batch causes at most one application per executor. Range changes do not prepare filters again. Topology and metrics construction remain independent of this subscription.

`SetAttributeFilter` stores `mode` and `selectedKeys`. Use `setSelection(mode, keys)` to change both atomically:

```ts
category.setSelection('exclude', ['idle', 'gc']);
category.setSelection('include', ['script', 'wasm']);
otherCategory.setSelection(category.mode, category.selectedKeys);
```

- `exclude` accepts every option except the selected keys. An empty selection is inactive and accepts everything.
- `include` accepts only the selected keys. An empty selection is active and accepts nothing.

Keys are semantic values, independent of local option order. Unknown keys are retained when transferring settings: a missing included key never turns into unrestricted acceptance. A mode change reinterprets the supplied keys; it does not convert them to the complement of the local options.

`isEnabled(key)` reports acceptance, and `setEnabled(key, enabled)` changes acceptance in either mode. `reset()` clears selected keys without changing mode: an include filter still rejects everything after reset. `allowAll()` explicitly removes the restriction by selecting empty exclude mode. The corresponding `FilterSet` operations apply to all settings in one batch, leaving population ranges unchanged. UI commands that remove restrictions call `allowAll()`, not `reset()`.

## Bucket Mask

`samplesMask` has one `Uint32` entry per sample ID, not per event. Each bit represents a sample-domain exclusion reason; zero means accepted by the bucket filters. Event-domain acceptance is applied in addition. Change low-level bits through `updateMask(callback)` and clear them through `resetMask()`. Low-level callers must not use bits reserved by registered filters. `resetMask()` preserves those bits and event acceptance; it does not change the line's settings. Direct array writes outside the callback do not trigger compilation or notifications.

```ts
filtered.updateMask(mask => {
    mask[sampleId] |= localFilterBit;
});
filtered.updateMask(mask => {
    mask[sampleId] &= ~localFilterBit;
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

This is a separation of attribute-predicate preparation from workspace encoding, not the complete M1 `PreparedPopulation` boundary. `Population.samples` still contains attribution-specific bucket IDs, category acceptance still uses that basis, and effective values/ranges remain in `PopulationFiltered`. Shared attribute predicates are not sufficient to merge the two memline populations. The remaining M1 work must separate participation/effective contribution from attribution without silently choosing one category basis for both paths.

Population updates still propagate eagerly to their subscribed breakdowns. Shared settings currently stop at the line boundary. Higher-level line/profile coordination, cross-line range translation, lazy metrics, result lifetime and viewport/selection separation remain separate steps.

Allocation CPU attribution preserves original allocation sizes. When mapping ends before allocation events, the remaining events use the last available CPU sample. Without CPU samples, memline does not create this borrowed call-stack breakdown; this does not implement all historical allocation-only profile formats.
