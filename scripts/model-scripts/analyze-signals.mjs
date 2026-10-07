// Signal consistency report: cross-checks CPU samples, allocations and compilation events
// of every profile of a trace. A script module of scripts/run-model.mjs:
//
//   node scripts/run-model.mjs [--option thread=<name|tid>] [--option json] \
//       scripts/model-scripts/analyze-signals.mjs <trace> ...

// The model keeps only the builtin frame for allocations with a builtin id,
// so the VM state of such allocations is not recoverable
const LABELS = [
    'js/other',
    'parser',
    'bytecode',
    'compiler',
    'program',
    'idle/gc/external',
    'builtin'
];
const IDLE_LABEL = 5;
const COMPILE_LABELS = [1, 2, 3];
const BUILTIN_LABEL = 6;
const LABEL_BY_FRAME_NAME = new Map([
    ['(parser)', 1],
    ['(bytecode compiler)', 2],
    ['(compiler)', 3],
    ['(program)', 4],
    ['(idle)', 5],
    ['(garbage collector)', 5],
    ['(external)', 5]
]);

function percent(value, total) {
    return total > 0 ? (value / total * 100).toFixed(1) + '%' : '-';
}

function attributeNames(memline) {
    return memline.attributes.map(attribute => attribute.name).join(', ');
}

function sum(values) {
    return values.reduce((total, value) => total + value, 0);
}

function createCounters() {
    return new Array(LABELS.length).fill(0);
}

// Flat table of label counters: row r occupies [r * LABELS.length, (r + 1) * LABELS.length)
function createCounterTable(rows) {
    return new Uint32Array(rows * LABELS.length);
}

function counterRow(table, row) {
    return table.subarray(row * LABELS.length, (row + 1) * LABELS.length);
}

function countLabels(labels) {
    const counters = createCounters();

    for (let i = 0; i < labels.length; i++) {
        counters[labels[i]]++;
    }

    return counters;
}

function labelColumns(counters, total, { withIdle = true } = {}) {
    const columns = LABELS.map((name, label) => [name, percent(counters[label], total), label]);

    return Object.fromEntries(
        columns
            .filter(([, , label]) => withIdle || label !== IDLE_LABEL)
            .map(([name, share]) => [name, share])
    );
}

// The leaf call frame of every population entry, reduced to a label code
function readLeafLabels(breakdown) {
    const { tree, sampleToNode } = breakdown.callFrames;
    const nodeLabels = new Uint8Array(tree.nodes.length);

    for (let node = 0; node < nodeLabels.length; node++) {
        const frame = tree.dictionary[tree.nodes[node]];

        nodeLabels[node] = frame?.kind === 'builtin'
            ? BUILTIN_LABEL
            : LABEL_BY_FRAME_NAME.get(frame?.name) ?? 0;
    }

    const entries = breakdown.population.samples;
    const labels = new Uint8Array(entries.length);

    for (let i = 0; i < entries.length; i++) {
        labels[i] = nodeLabels[sampleToNode[entries[i]]];
    }

    return labels;
}

// Innermost-event segments: [starts[i], ends[i]] belongs to owners[i]
function buildOwnerTimeline(compilations) {
    const events = compilations
        .filter(record => record.tm !== null && record.duration > 0)
        .sort((a, b) => a.tm - b.tm || b.duration - a.duration);
    const starts = [];
    const ends = [];
    const owners = [];
    const names = [];
    const nameIds = new Map();
    const open = [];
    let cursor = 0;

    function nameId(name) {
        let id = nameIds.get(name);

        if (id === undefined) {
            id = names.length;
            names.push(name);
            nameIds.set(name, id);
        }

        return id;
    }

    function emitUntil(time) {
        if (open.length > 0 && time > cursor) {
            starts.push(cursor);
            ends.push(time);
            owners.push(open.at(-1).nameId);
        }

        cursor = time;
    }

    for (const event of events) {
        while (open.length > 0 && open.at(-1).end <= event.tm) {
            emitUntil(open.at(-1).end);
            open.pop();
        }

        emitUntil(event.tm);

        const end = event.tm + event.duration;
        const parentEnd = open.at(-1)?.end ?? end;

        open.push({ nameId: nameId(event.name), end: Math.min(end, parentEnd) });
    }

    while (open.length > 0) {
        emitUntil(open.at(-1).end);
        open.pop();
    }

    return {
        starts: Float64Array.from(starts),
        ends: Float64Array.from(ends),
        owners: Uint32Array.from(owners),
        names
    };
}

function ownerIndexAt(timeline, time) {
    let low = 0;
    let high = timeline.starts.length;

    while (low < high) {
        const middle = (low + high) >> 1;

        if (timeline.starts[middle] <= time) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    const found = low > 0 && time <= timeline.ends[low - 1];

    return found ? low - 1 : -1;
}

function sampleTimes(timeline) {
    const { values, axisStart, axisStartNoSamples } = timeline;
    const times = new Float64Array(values.length);
    let time = axisStart + axisStartNoSamples;

    for (let i = 0; i < values.length; i++) {
        times[i] = time;
        time += values[i];
    }

    return times;
}

function signalsSection({ timeline, memline, thread }) {
    const compilations = thread?.compilations ?? [];
    const yesNo = value => value ? 'yes' : 'no';

    return {
        title: 'Signals',
        rows: [
            {
                signal: 'CPU samples',
                present: yesNo(timeline),
                detail: timeline
                    ? `${timeline.sourceInfo.samples} samples, ` +
                        `interval ${timeline.sourceInfo.samplesInterval} us`
                    : ''
            },
            {
                signal: 'Allocations',
                present: yesNo(memline),
                detail: memline
                    ? `${memline.sourceInfo.samples} allocations, ` +
                        `attributes: ${attributeNames(memline)}`
                    : ''
            },
            {
                signal: 'Compilation events',
                present: yesNo(compilations.length > 0),
                detail: compilations.length > 0 ? `${compilations.length} records` : ''
            },
            {
                signal: 'Allocation to CPU mapping',
                present: yesNo(timeline?.mappings.memline),
                detail: ''
            }
        ]
    };
}

function integritySection(integrity, sampleLabels) {
    const rows = integrity.map(({ title, status, detail }) => ({
        check: title,
        result: status === 'warn' ? 'WARN' : status,
        detail
    }));

    if (sampleLabels !== null) {
        const labelCounts = countLabels(sampleLabels);
        const counts = COMPILE_LABELS.map(label => `${LABELS[label]} ${labelCounts[label]}`);

        rows.push({
            check: 'Samples with a compile leaf frame',
            result: 'info',
            detail: counts.join(', ')
        });
    }

    return { title: 'Integrity', rows };
}

function cpuSamplesSections(times, sampleLabels, owners) {
    const total = createCounters();
    const covered = createCounters();
    const byOwner = createCounterTable(owners.names.length);

    for (let i = 0; i < times.length; i++) {
        const label = sampleLabels[i];
        const segment = ownerIndexAt(owners, times[i]);

        total[label]++;

        if (segment !== -1) {
            covered[label]++;
            byOwner[owners.owners[segment] * LABELS.length + label]++;
        }
    }

    const coverageRows = LABELS
        .map((name, label) => ({
            label: name,
            samples: total[label],
            insideEvents: covered[label],
            share: percent(covered[label], total[label])
        }))
        .filter(row => row.samples > 0);
    const eventRows = owners.names
        .map((event, id) => ({ event, counters: counterRow(byOwner, id) }))
        .map(({ event, counters }) => ({ event, samples: sum(counters), counters }))
        .sort((first, second) => second.samples - first.samples)
        .slice(0, 14)
        .map(({ event, samples, counters }) => ({
            event,
            samples,
            ...labelColumns(counters, samples)
        }));

    return [
        { title: 'CPU samples vs events: coverage of samples by label', rows: coverageRows },
        { title: 'CPU samples vs events: innermost event and sample label', rows: eventRows }
    ];
}

function countLabelsByStage(allocationLabels, stage) {
    const byStage = createCounterTable(stage.dict.length);

    for (let i = 0; i < allocationLabels.length; i++) {
        byStage[stage.values[i] * LABELS.length + allocationLabels[i]]++;
    }

    return byStage;
}

function compareStageRows(first, second) {
    const firstIsNone = first.event === 'none';
    const secondIsNone = second.event === 'none';

    return Number(firstIsNone) - Number(secondIsNone) || second.allocations - first.allocations;
}

function allocationSections(memline) {
    const location = memline?.breakdowns.find(breakdown => breakdown.kind === 'location');
    const stage = memline?.attributes.find(
        attribute => attribute.name === 'allocationCompilationStage'
    );

    if (!location || !stage) {
        return [];
    }

    const byStage = countLabelsByStage(readLeafLabels(location), stage);
    const noneId = stage.dict.indexOf('none');
    const outside = noneId !== -1 ? counterRow(byStage, noneId) : createCounters();
    const inside = createCounters();

    for (let id = 0; id < stage.dict.length; id++) {
        if (id === noneId) {
            continue;
        }

        const counters = counterRow(byStage, id);

        for (let label = 0; label < LABELS.length; label++) {
            inside[label] += counters[label];
        }
    }

    const stageRows = stage.dict
        .map((event, id) => ({ event, counters: counterRow(byStage, id) }))
        .map(({ event, counters }) => ({ event, allocations: sum(counters), counters }))
        .filter(row => row.allocations > 0)
        .sort(compareStageRows)
        .slice(0, 16)
        .map(({ event, allocations, counters }) => ({
            event,
            allocations,
            ...labelColumns(counters, allocations, { withIdle: false })
        }));
    const outsideRows = COMPILE_LABELS.map(label => ({
        vmState: LABELS[label],
        inside: inside[label],
        outside: outside[label],
        outsideShare: percent(outside[label], inside[label] + outside[label])
    }));

    return [
        {
            title: 'Allocations vs events: VM state of allocations by innermost event',
            rows: stageRows
        },
        {
            title: 'Allocations vs events: compile-state allocations outside events',
            rows: outsideRows
        }
    ];
}

function analyzeProfile(profile, integrity) {
    const { timeline, thread } = profile;
    const compilations = thread?.compilations ?? [];
    const callStack = timeline?.breakdowns.find(breakdown => breakdown.kind === 'call-stack');
    const sampleLabels = callStack ? readLeafLabels(callStack) : null;
    const sections = [
        signalsSection(profile),
        integritySection(integrity, sampleLabels)
    ];

    if (sampleLabels !== null && compilations.length > 0) {
        sections.push(...cpuSamplesSections(
            sampleTimes(timeline),
            sampleLabels,
            buildOwnerTimeline(compilations)
        ));
    }

    sections.push(...allocationSections(profile.memline));

    return sections;
}

async function renderTable(model, rows) {
    const columns = Object.keys(rows[0]);
    const cols = columns.map((name, index) => ({
        header: name,
        content: `text:c${index}`
    }));
    const data = rows.map(row =>
        Object.fromEntries(columns.map((name, index) => [`c${index}`, String(row[name])]))
    );
    const { text } = await model.textView.renderString(
        null,
        { view: 'table', cols },
        data,
        model.getContext()
    );

    return text;
}

function matchesThread(thread, filter) {
    if (filter === null) {
        return true;
    }

    return thread?.name === filter || String(thread?.tid) === filter;
}

async function renderReport(model, { thread, tid, sections }) {
    const lines = [`\n# ${thread ?? '(no thread)'} tid=${tid ?? '-'}`];

    for (const { title, rows } of sections) {
        lines.push(`\n## ${title}`);
        lines.push(rows.length > 0 ? await renderTable(model, rows) : '(no data)');
    }

    return lines.join('\n');
}

export default async function analyzeSignals(model, { options }) {
    const threadFilter = options.thread ?? null;
    const reports = [];

    for (const [index, profile] of model.data.profiles.entries()) {
        if (!matchesThread(profile.thread, threadFilter)) {
            continue;
        }

        const integrity = await model
            .queryChain()
            .query('profiles[#.args.index].signalIntegrity()', { index });

        reports.push({
            thread: profile.thread?.name ?? null,
            tid: profile.thread?.tid ?? null,
            sections: analyzeProfile(profile, integrity)
        });
    }

    if (options.json !== undefined) {
        return reports;
    }

    const texts = [];

    for (const report of reports) {
        texts.push(await renderReport(model, report));
    }

    return texts.join('\n');
}
