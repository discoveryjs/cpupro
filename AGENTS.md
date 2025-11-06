We’re in the middle of a data-model migration for profiles in CPUpro, so the core thing to explain is **what changed and what’s still to do**.

Right now:

* A profile is still the same top-level object, but the time-based CPU view has been pulled out into a dedicated **`timeline` line**.
* `timeline` is a **generic line core** with:

  * `kind: 'time'`
  * axis metadata (`axisStart/End/...`)
  * canonical sample domain (`samples`, `sampleCounts`, `samplePositions`)
  * a generic metric vector (`values`, `valuesByProfile`, `samplesMetrics`, `samplesMetricsFiltered`, `recomputeValues`)
  * per-dimension aggregates (`locations`, `callFrames`, `modules`, `packages`, `categories`) all sharing the same `{ values, valuesFiltered, treeValues, treeValuesFiltered, treeValueBounds }` shape.
* The top-level `profile` now exposes:

  * shared dictionaries and trees (`positionsTreeSource`, `callFramePositionsTree`, `callFramesTree`, `modulesTree`, …),
  * `timeline` plus placeholders for `memline` and `gcline`,
  * and a **compatibility layer**: legacy fields like `startTime`, `timeDeltas`, `callFramesTimings`, etc. are re-exported via `transitionTimelineGetters()` as `Object.defineProperty` getters/setters that delegate into `timeline`.

What still needs to be done (and what this refactor is preparing for):

1. **Finish the line abstraction**
   Treat `timeline`, `memline`, `gcline` as the same conceptual type:

   * uniform core fields (`kind`, `sourceInfo`, `axis*`, `samples`, `values`, `samplesMetrics`, dimensions with `{ values, treeValues, ... }`),
   * with only domain-specific extras on top.

2. **Implement additional lines**

   * Populate `memline` for allocation/heap metrics using the same structure (samples + values + dimensions over the same trees).
   * Populate `gcline` for GC/heap-size metrics if needed.

3. **Add line-to-line mapping metadata**

   * Store mapping vectors between lines (e.g. timeline↔memline) so we can project selections from one line into another.

4. **Migrate consumers off legacy fields**

   * Gradually update all code that reads `profile.startTime`, `profile.timeDeltas`, `profile.callFramesTimings`, etc. to use `profile.timeline.*` (or `memline/gcline`).
   * Once all consumers are updated, the transition getters and legacy fields can be removed.

So the snippet shows the **new single-line (timeline) model already in place**, a **compat layer on top of it**, and empty slots ready for memory and GC lines. The remaining work is to fill in those lines and move the rest of the codebase to talk to lines instead of the old flat profile fields.

**Motivation:**
The original profile data model in CPUpro was designed purely for CPU time profiles. As support expanded to include memory allocations and GC events, it became clear that many concepts (samples, trees, metrics, aggregations) are shared — but the old structure was too time-centric and rigid to reuse cleanly.

**Purpose:**
The refactor introduces a **unified, extensible line-based model** where each metric domain — CPU time, memory, GC, etc. — is represented as a separate *line* with the same core structure (samples, values, aggregates, trees). This enables:

* consistent processing and visualization of different metrics;
* easy correlation between domains (e.g. CPU ↔ memory ↔ GC);
* better memory efficiency through shared dictionaries and trees;
* and a smoother migration path away from legacy time-specific fields.

## Core Components

### Input Processing

**Format Detection** (`app/prepare/index.ts`)
- Auto-detects format from content
- Supported: V8 Log (.log), V8 CPU Profile (.cpuprofile), Chrome Performance Profile, Edge Enhanced Traces
- Normalizes to unified `V8CpuProfile` structure

**V8 Log Streaming** (`app/encodings/v8log/`)
- **Streaming decoder** for raw V8 logs (constant memory usage)
- **Line-by-line parsing** with efficient newline detection
- **Event processing**: code-creation, ticks, scripts, ICs, deoptimizations
- **CodeMap**: Bucketed memory layout for O(log n) PC→code lookups
- **Stack resolution**: Converts raw addresses to call trees

**V8 Log Conversion** (`app/prepare/formats/v8-log-processed/`)

Converts preprocessed V8 logs to unified format:

```
processFunctions() → Extract function definitions
createCallFrames() → Build call frame dictionary  
processCodes() → Track optimization tiers
processCodePositionTables() → Map PC to source
processTicks() → Convert samples to call tree
```

Key algorithms:
- **Stack walking**: Resolves PCs to call frames with inline unwinding
- **Node deduplication**: Reuses identical (frame, offset) nodes
- **Position resolution**: Maps code addresses to source locations

### Dictionary System (`app/prepare/dictionary.ts`)

Centralized entity registry with deduplication:

```typescript
Dictionary {
    callFrames: CpuProCallFrame[]  // Unique function frames
    scripts: CpuProScript[]         // JS files/modules
    modules: CpuProModule[]         // Logical code groupings
    packages: CpuProPackage[]       // Package-level groupings
    categories: CpuProCategory[]    // High-level categories
}
```

**Hierarchy**: `Category → Package → Module → Script → CallFrame`

**Features**:
- Deduplication by content identity
- Map-based O(1) lookups
- Package registry detection (npm, jsr, deno, GitHub)
- CDN detection (unpkg, jsdelivr, skypack)

### Data Preparation Pipeline (`app/prepare/setup-prepare.mts`)

Orchestrates transformation from raw data to optimized model:

1. **Extract & Validate** - Parse and detect format
2. **Create Dictionary** - Initialize shared entity storage
3. **Process Profiles** - Transform each profile
4. **Cross-Profile Analysis** - Compute multi-profile metrics
5. **Path Processing** - Optimize display paths
6. **Name Processing** - Generate readable names
7. **Object Marking** - Tag for Discovery.js

**Performance tracking** with `setWorkTitle()` and optional timing measurements.

### Profile Processing (`app/prepare/profile.mts`)

Transforms raw profiles into analysis-ready structures:

**Pipeline stages**:
1. **Time Delta Processing** - Normalize timestamps, fix out-of-order samples
2. **Sample Merging** - Merge identical consecutive samples (~50% reduction)
3. **GC Reparenting** - Attach GC samples to parent stacks
4. **Call Frame Extraction** - Map nodes to dictionary entries
5. **Code Tier Processing** - Track V8 optimization (Ignition→Turbofan)
6. **Position Tracking** - Build position-aware trees
7. **Tree Building** - Create hierarchical structures
8. **Timings Computation** - Calculate self/total times

**Profile data model** (old):
```typescript
Profile {
    // Metadata
    name, type, runtime, startTime, endTime, totalTime
    
    // Sample data (TypedArrays)
    samples: Uint32Array          // Node IDs
    sampleCounts: Uint32Array     // Merged count
    timeDeltas: Uint32Array       // Duration
    samplePositions: Int32Array   // Script offsets
    
    // Call trees (multi-level)
    callFramesTree, modulesTree, packagesTree, categoriesTree
    
    // Timings (self/total)
    samplesTimings, callFramesTimings, modulesTimings, ...
    
    // Code analysis
    codes: CpuProCallFrameCode[]  // Optimization tiers
}
```

### Preprocessing Layer (`app/prepare/preprocessing/`)

**Sample Processing** (`samples.ts`)
- `mergeSamples()` - Lossless compression (~50% reduction)
- `remapSamples()` - Compact ID space
- `computeTimings()` - Initialize timing system

**Time Processing** (`time-deltas.ts`)
- Fix negative/out-of-order deltas
- Compute sampling interval (median-based)
- Calculate startup/shutdown overhead
- Adjust for actual profiling time

**Node Processing** (`nodes.ts`)
- `mapNodes()` - Node→call frame mapping
- `createNodeParent()` - Build parent relationships
- `createNodePositions()` - Extract script offsets

**Call Frame Extraction** (`call-frames.ts`)
- Resolve nodes to dictionary call frames
- Handle V8 log vs cpuprofile formats
- Support generated/synthetic nodes

**Code Tier Processing** (`call-frame-codes.ts`)
- Track optimization history (Ignition, Sparkplug, Maglev, Turbofan)
- Process inline cache states
- Store deoptimization events
- Keep disassembly data

**GC Handling** (`gc-samples.ts`)
- `reparentGcNodes()` - Attach GC to triggering code
- Generate linking nodes as needed
- Preserve tree integrity

**Path Optimization** (`short-paths.ts`)
- Remove common prefixes
- Generate package-relative paths
- Clean URLs for display

### Computation Layer (`app/prepare/computations/`)

**Call Tree System** (`call-tree.ts`)

Generic tree structure:
```typescript
CallTree<T> {
    dictionary: T[]                // Entity definitions
    sourceIdToNode: Int32Array     // Source mapping
    sampleIdToNode: Uint32Array    // Sample→node
    nodes: Uint32Array             // Node→dictionary
    parent: Uint32Array            // Hierarchy
    subtreeSize: Uint32Array       // Subtree counts
    nested: Uint32Array            // Recursion tracking
    
    // Entry lookup (lazy)
    entryNodes: Uint32Array
    entryNodesOffset: Uint32Array
    entryNodesCount: Uint32Array
}
```

**Timings System** (`timings.ts`, `timings.wasm`)

Dual implementation (JS fallback + WASM acceleration):

```typescript
SamplesTimings {
    samples, timeDeltas, timestamps, samplesCount, samplesTimes
}

DictionaryTimings<T> {
    selfTime, totalTime, selfSamples, totalSamples
}

TreeTimings<T> {
    selfTime, nestedTime, totalTime
}
```

**Observer pattern** for reactive timing updates.

**Tree Building** (`build-trees.ts`)

Core algorithms:
- `firstNextFromParent()` - Convert to first-child/next-sibling
- `subtreeFromParent()` - Compute subtree sizes
- `nestedFromNodesSubtree()` - Detect recursion
- `buildCallTreeArrays()` - Map to dictionary

**Multi-level projection**:
```
CallFrameTree → ModuleTree → PackageTree → CategoryTree
```

**Cross-Profile Analysis** (`cross-profile-usage.mts`)
- Compute presence across profiles
- Profile selection/filtering
- Identify common/unique code paths

**Sample Convolution** (`samples-convolution.mts`)
- Filter samples by rules
- Apply module/presence/top-level filters
- Trigger timing recomputation

### Type System (`app/prepare/types.ts`)

**Core entities**:
```typescript
CpuProCallFrame {
    id, script, name, kind, line, column, loc
    module, package, category
}

CpuProModule {
    id, type, name, path, script, category, package
}

CpuProPackage {
    id, type, name, version, registry, cdn, path, category
}

CpuProCategory {
    name  // script, node, internals, gc, etc.
}
```

**V8 types**: CPU profiles, nodes, call frames, code tiers (Ignition→Turbofan)


## Presentation Layer

### Application Setup (`app/setup.mts`)

- Define object markers for navigation
- Register Jora query extensions
- Link to data preparation pipeline

### Client Init (`app/init-client.mjs`)

- Actions: `selectProfile()`, `toggleProfile()`, `setSamplesConvolutionRule()`
- Session storage management
- Navigation setup

### Jora Extensions (`app/jora/`)

Custom query methods:
- **Formatting**: `percent()`, `duration()`, `ms()`, `kb()`, `bytes()`
- **Tree operations**: Call tree querying, sample filtering
- **Binary search**: Efficient sorted array lookups
- **Source mapping**: Position tables, disassembly

### Pages (`app/pages/`)

Main views:
- **`default.js`** - Main profile view (flamechart, statistics)
- **`call-frame.js`** - Function analysis (source, tiers, ICs)
- **`module.js`** - Module-level analysis
- **`package.js`** - Package-level analysis
- **`profiles-matrix.js`** - Multi-profile comparison
- **`all-*.js`** - List views (frames, modules, packages)

### Views (`app/views/`)

Reusable components:
- **Flamechart** (`flamechart/`) - Canvas-based, interactive zoom/pan
- **Timelines** - Multi-profile, segmented, time ruler
- **Tables** - Code history, inlining matrix, allocations
- **Badges** - Function kind, location, optimization tier
- **Source views** - Function source, assembly, full scripts
- **Charts** - Stacked bars, tree timing visualization

---

## Data Flow

### Complete Pipeline

```
Input Sources (V8 Log, CPU Profile, etc.)
    ↓
Format Detection → Route to decoder
    ↓
┌─────────────────┬──────────────────┐
│ V8 Log Stream   │ Other Formats    │
│ (streaming)     │ (direct)         │
└────────┬────────┴────────┬─────────┘
         ↓                 ↓
    V8LogProfile → V8CpuProfile (unified)
         ↓
Validation & Normalization
         ↓
Dictionary Creation (shared entities)
         ↓
Profile Processing (for each):
  1. Time delta processing
  2. Sample merging
  3. GC reparenting
  4. Call frame extraction
  5. Code tier processing
  6. Position tracking
  7. Node processing
  8. Tree building
  9. Timings computation
         ↓
Cross-Profile Analysis
         ↓
Path & Name Processing
         ↓
Object Marking
         ↓
Final Data Model
         ↓
Client Initialization
         ↓
Discovery.js Rendering (Pages → Views → Jora)
```
