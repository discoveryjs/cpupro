# Population Filtering

`Population` keeps the original event vectors and aggregates by sample ID. `PopulationFiltered` accepts a Base or another `PopulationFiltered` as its immediate `source`; its existing `population` property still identifies Base for structural consumers. Each derived owns independent `samples`, `values` and aggregate buffers. Events and sample IDs are different domains: there may be many events for one sample ID.

`values` retains the full source weight of each participating event, with zeros outside effective ranges or rejected by local index/value constraints. Attribute filters preserve weights and route rejected events to sink. Event indices never change, and `cumulative` and `cumulativeEnd` retain the Base coordinate axis. Do not derive coordinates by summing derived values or pass them to a binning routine that interprets weights as consecutive coordinate lengths.

The unchanged JS/WASM kernels aggregate these full weights. A second pass applies boundary cuts to `samplesTotal` and, when the truncated contribution is zero, `samplesCount`, including their sink cells. Subscribers see only the completed result. Cut descriptors cost O(range boundaries); there is no second event-sized values vector or second totals vector. Derived consumers use source events and coverage, never source aggregates as input.

Each derived keeps `requestedRanges` separately from effective `ranges`, which intersect its request with source ranges. Local `null` inherits the source; `[]` stays empty. Source updates refresh the child, even when a changed range has identical aggregate totals. `samplesRevision` tracks destination changes so a source range-only update does not execute attribute predicates again. The existing observers remain synchronous; `destroy()` detaches the source subscription without resetting the last result.

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

The callback evaluates bucket-level predicates over ordinary sample IDs. Compilation then maps each source event's sample ID to itself or `sinkId`. An incoming sink stays sink without consulting local masks or event predicates. Changing ranges does not rerun this callback. Source filters and their bit assignments are not copied into the child. Different attribution domains may have different masks even when their filter descriptions are shared.

The hot aggregation kernels retain their current operations: sum input values and count nonzero input values. The boundary patch produces effective totals and counts after this accumulation. No filter predicates are evaluated by these kernels.

## Sink

For a public sample domain of size `U`, `sinkId` is `U`. Internal `buffer.samplesCount` and `buffer.samplesTotal` have `U + 1` cells. Public `samplesCount` and `samplesTotal` are stable views of `[0, U)`; projections never consume the sink cell.

Base exposes the same sink contract. `new Population(samples, values, sampleCount)` can declare the ordinary sample-domain size when input already contains sink IDs; omitted `sampleCount` preserves inference from ordinary samples. All descendants retain this domain and sink ID. Local filter reset cannot restore a source sink; a subsequent source destination update can. Attribute domains exclude sink: it has no category or event attributes to query.

`sink` returns `{ count, total }` for masked events that still have a nonzero effective contribution after all range/value constraints. Events outside those constraints contribute zero, including to the sink. This is not a total of every excluded event in the original profile.

`samples` always refers to the internal compiled event-to-bucket vector, including sink IDs. Consumers that inspect events directly must reject IDs outside the public aggregate domain. Historical bounds use the original `Population.samples` instead.

## Value Constraints

The coordinate model consists of interval values (`Range`), normalized immutable `RangeSet` values, and `CoordinateFrame` transforms within an explicitly identified space. Equal units alone do not establish a shared space. Frames currently support translation to a common parent space, not arbitrary cross-space mappings or a nested frame hierarchy. Base Population has no placement offset.

`RangeSelection` owns the requested interval set directly in its coordinate space. It has no source frame or movable origin. `null` means unrestricted; `[]` means explicitly empty. `RangeView` joins that request with a local frame and extent. Its `ranges` are the rebased, unclipped request, while `coverage` is their intersection with the extent. Neither is an independently mutable copy. Moving the local frame invalidates this resolution without changing the requested interval set.

`selection.ranges`, `frame.origin`, and the view's `ranges`, `coverage` and `resolvedExtent` are own enumerable getters, available to Discovery inspection and Jora queries. `extent` stays local; `resolvedExtent` expresses its bounds in `selection.space` through the current frame. These are live derived properties, not synchronized copies. The Selected indicator sums `end - start` over normalized local `coverage`, counting overlaps once and excluding portions outside the line extent.

The usual construction is `new RangeSelection(space).view(extent, origin)`, with origin defaulting to zero. This creates one request, one local frame and one view; there is no materialized zero frame for the space. A view subscribes only to the request and its local frame. Explicit `new RangeView(selection, frame, extent)` is still available when multiple views must share an existing movable frame. `frame.resolve()` translates local ranges into space coordinates, and `frame.rebase()` translates space coordinates into local ones. RangeView checks space identity before joining them; equal units alone do not permit cross-space composition.

For example, requested `[1,3) U [5,8) U [12,15)` against extent `[2,13)` has effective coverage `[2,3) U [5,8) U [12,13)`. The missing `[1,2)` and `[13,15)` remain recoverable from request/extent; they are not the same as the unselected `[3,5)` gap. Coordinate resolution also works for timestamped points without sample IDs or structural projections.

`line.range` is a compatibility access to a `RangeView`, not population identity. Each line retains its own `RangeSelection`, local frame and extent. Timeline placement is `axis.start + axis.startNoSamples`; cumulative-bytes placement is zero. Preparation does not link selections. Other presentations can reference a line's selection through a different frame; independent analytical scopes over one Base use separate derived workspaces.

After collecting breakdowns, `prepareLineRange()` connects distinct existing workspaces through `applyRangeToPopulation()`. This one-way migration adapter sends resolved local coverage to `PopulationFiltered.setRanges()`; it never propagates a local clamp back to the request. It subscribes through the coordinate view, not through Base Population. Its returned function stops updates without resetting results. The adapter is retired when explicit derived populations consume scopes and coverage directly, independently of breakdown discovery.

UI gestures call `RangeView.setRange()` in local display coordinates; the view resolves them into the request's coordinate space. Rulers have no separate origin parameter. They render multiple intervals without filling internal gaps; the current drag operation replaces the request with one interval. Runtime tracks consume the request directly in space coordinates. Full absent-coverage shading and multi-interval editing controls remain representation work.

Coordinate descriptors and their transient transformations cost O(number of intervals). Each derived uses its own existing-style workspace, with no additional occurrence-sized arrays for clipping, projection mappings or topology copies. Multi-range preparation uses that workspace; the optimized single-range path and JS/WASM aggregation kernels are retained.

AC installs `subscribeSelectionSync()` for the loaded profiles and supplies the current peers. Its present policy synchronizes enabled profiles in the same bucket immediately, using their aligned recording-time coordinates. Bucket membership is read for each request, not fixed during preparation; other synchronization policies and unrelated recording clocks are not inferred from equal units. Switching a profile or line is navigation only and does not replay a translated selection. Unload detaches the subscriptions.

`RangeSelection.subscribe()` reports changed range values only; `updates.subscribe()` reports each explicit request, including an equal one. AC suppresses propagation from writes it makes to recipients. Thus a lossy time projection of a byte selection never feeds back into the source, but a subsequent explicit request on time can replace that byte selection even if the time range itself did not change. No common mutable selection or per-line shadow range is stored by the synchronizer.

`mapLineRanges()` uses the existing allocation-to-CPU-occurrence relation, not the reverse array of allocation IDs as if it contained indices. Time ranges select allocations whose associated CPU sample timestamp lies in the half-open range. Each byte range maps to one time interval from the start of the first affected CPU sample to the end of the last. Samples without allocations inside that interval do not create gaps in the selection. Separate input ranges are translated separately, then overlapping results are merged. This is sample-resolution correlation, not reconstructed native allocation timestamps or interpolation within an allocation. The original byte request retains its exact boundaries. Both allocation attribution workspaces consume the resulting one local selection. Missing mapping returns `undefined` (leave the recipient unchanged), distinct from `[]` (no mapped coverage) and `null` (reset reachable selections).

Mapping borrows immutable cumulative vectors from existing population workspaces; that access through breakdowns remains a migration dependency, not projection ownership of coordinates. Binary searches locate the endpoints of each range without scanning intervening samples or allocations. Only interval descriptors are produced; no new occurrence vectors, mappings, trees or WASM memories are retained. Changed local coverage eagerly updates existing recipient workspaces, including inactive profiles selected by the AC policy. Lazy computation, batched publication and editable bucket policies remain separate work.

All local constraints are half-open. They are applied to the source's full participating weights, not its clipped aggregates. Within one derived, index/value/range constraints remain independent of setter order:

| Method | Meaning |
| --- | --- |
| `setRanges(ranges)` | Local request; overlapping intervals are normalized, clipped to the Base extent, then intersected with source coverage for execution. |
| `setRange(start, end)` | Coordinate range on the original cumulative axis; boundary events contribute only their overlap. |
| `setIndexRange(start, end)` | Original event-index interval; events outside it get zero effective value. |
| `setValueRange(min, max)` | Accept original values in `[min, max)`; this is a predicate, not value clamping. |

Index boundaries must be integers. Coordinate/index endpoints are clamped to the input domain; reversed or non-finite endpoints are rejected. For index/value ranges, `null` is an open bound and two nulls clear the constraint. For the existing coordinate API, either null endpoint resets the range. `resetRange()`, `resetIndexRange()` and `resetValueRange()` reset only their respective constraint, leaving the mask and other constraints in place.

`PopulationFiltered.rangeStart/rangeEnd` are legacy effective-envelope getters, not a multi-interval request. Computation uses `ranges`, including gaps. When several ranges overlap one duration-bearing event, contributions are summed before typed-array truncation and the event is counted once. Every descendant computes cuts from full source weights and exact effective ranges, so it does not inherit an earlier level's truncation. The existing cumulative-bytes allocation clipping policy is preserved in this compatibility path; native allocation-timestamp participation is not implemented by treating byte weights as durations.

`rangeSamples` counts events with positive coordinate overlap before bucket masking and index/value acceptance; it is null when no coordinate range is active. It is not the filtered count. Effective values and counts still use the existing integer typed-array representation. Fractional storage and cumulative-axis overflow are not redesigned here.

Range preparation assumes a non-overflowed cumulative axis: it finds the event interval by binary search, clears the prefix/suffix with typed-array fills and processes only the interval. Participating events retain their full weights; only the first and last events need aggregate cuts. Repeated coordinates from zero-sized events are handled by distinct lower/upper boundaries. `computeCumulative()` builds the coordinate vector using local arrays. This does not allocate an additional event vector or change the aggregation kernel's full scan.

Multi-range preparation iterates normalized intervals, seeking each interval's event boundaries separately. Gaps are zeroed with typed-array fills; their events are not visited by the JavaScript event loop. That loop copies whole weights and applies index/value constraints without inspecting ranges or computing overlaps. Only interval edges use overlap arithmetic. A scalar accumulator retains contributions when successive intervals share an edge event, preserving fractional sums and recording one aggregate cut per affected event. Cuts are reused on mask changes with the new sample destinations. No event-sized scratch vector is needed. The aggregation kernel still scans the resulting full vector.

Overflow handling is deferred for both `cumulative` and aggregate vectors such as `samplesTotal`. They remain `Uint32Array`; there is no separate fallback for wrapped coordinates or claim of correct range results after overflow. Widening only the coordinate vector would not solve aggregate overflow.

Set/reset order must not affect compiled inputs or aggregates. Base vectors, source topology, and public filtered-vector identities remain unchanged. An effective mask change or changed range constraint recomputes aggregates and notifies subscribers; identical range updates are ignored.

## Current Boundaries

Profile preparation constructs `Base -> populationViewport -> populationFiltered` for timeline and each memline attribution population. Source-mapped breakdowns share both derived workspaces; they do not create another chain or another tree topology. `line.viewport` and `line.range` use independent requests in the same coordinate frame. Preparation binds them to the viewport and selection workspace respectively. Local selection requests survive viewport changes, including non-overlap.

Existing `line.filters` target viewport populations. Selection retains its own independent `PopulationFilter` for focused constraints. Category sample bins, sample counters and allocation histograms consume viewport participation and effective ranges while advancing along Base coordinates. The existing integer sample-bin step and two-pass accumulation remain in use. Disjoint intervals are accumulated on the same display grid; sample counters count each event once per bin. The filter summary reports viewport included/excluded values, independent of selection. The main timeline panel subscribes to viewport changes, not selection changes. Base overview and baseline tree/dictionary metrics remain full.

An explicit viewport request supplies the display envelope; without one, time lines retain the common recording envelope and byte lines retain their own extent. Separate pointer controls and cross-profile viewport synchronization are not implemented yet. Counter/code-state/user-timing streams retain their own evidence coordinates: changing sample filters does not erase independent runtime evidence. They follow the display viewport where already bound to it. Subject detail pages read the same viewport on render; a shared analytical-context viewport controller remains a subsequent integration step.

`Population.samples` still contains attribution-specific bucket IDs, category acceptance still uses that basis, and effective contribution/local coverage materialization remain fused in `PopulationFiltered`. Frame placement does not merge attribution domains. The coordinate module itself has no dependency on population, line or projection types. Higher-level scope ownership, classifier capabilities upstream of breakdowns, and source-map readiness remain open construction work.

Population updates still propagate eagerly to their subscribed breakdowns. Shared filter settings currently stop at the line boundary. Higher-level viewport coordination, lazy metrics and result lifetime remain separate steps. Selection continues to use the existing cross-line/cross-profile synchronization policy.

Allocation CPU attribution preserves original allocation sizes. When mapping ends before allocation events, the remaining events use the last available CPU sample. Without CPU samples, memline does not create this borrowed call-stack breakdown; this does not implement all historical allocation-only profile formats.
