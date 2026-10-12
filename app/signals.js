export const signalScopes = `
    (profiles or []) + (defaultSession.processes.threads or []).[no profiles and compilations].({ thread: $ })
    | $ or [{}]
`;

export const signalScopeLabel = `[
    thread.name or name or 'Profile',
    thread.pid is number ? 'pid:' + thread.pid,
    thread.tid is number ? 'tid:' + thread.tid
].[$].join(' ')
`;

export const compilationPopulation = `
    (thread.compilations or []).group(=>name).({
        name: key,
        count: value.size(),
        timed: value.[duration > 0 and tm is number].size(),
        instant: value.[duration = 0 and tm is number].size(),
        unfinished: value.[duration is not number or duration < 0 or tm is not number].size(),
        duration: value.[duration > 0].duration.sum() or 0,
        maxDuration: value.[duration is number].duration.max(),
        first: value.[tm is number].tm.min(),
        last: value.[tm is number].(tm + (duration > 0 ? duration : 0)).max()
    }).sort(count desc)
`;

export const signalWindows = `
    $origin: timeline.axisStart or 0;
    $ids: timeline.mappings.memline._mapping;
    $events: thread.compilations;
    $timed: $events.[tm != null];
    $ranged: $events.[
        allocationStart != null and allocationEnd != null and allocationEnd > allocationStart
    ];
    [
        {
            title: 'CPU samples', count: timeline.sourceInfo.samples,
            time: timeline ? {
                start: timeline.axisStartNoSamples, end: timeline.axisEnd - $origin
            } : null,
            ids: $ids ? { start: $ids[0], end: $ids[-1] } : null
        },
        {
            title: 'Allocations', count: memline.sourceInfo.samples, time: null,
            ids: memline ? { start: 0, end: memline.sourceInfo.samples } : null
        },
        {
            title: 'Compilation events', count: $events.size(),
            time: $timed ? {
                start: $timed.tm.min() - $origin,
                end: $timed.(tm + (duration > 0 ? duration : 0)).max() - $origin
            } : null,
            ids: $ranged ? {
                start: $ranged.allocationStart.min(), end: $ranged.allocationEnd.max()
            } : null
        }
    ]
`;

export const signalMeasurements = [
    {
        title: 'Time before the first sample', unit: 'us', when: 'timeline',
        definition: 'Time from the start of the profile axis to the first CPU sample.',
        data: '{ value: timeline.axisStartNoSamples }'
    },
    {
        title: 'Time after the last sample', unit: 'us', when: 'timeline',
        definition: 'Time from the last CPU sample to the end of the profile axis.',
        data: '{ value: timeline.axisEndNoSamples }'
    },
    {
        title: 'Sample deltas longer than 2.5 intervals', when: 'timeline',
        definition: 'Number of sample intervals longer than 2.5 nominal sampling intervals.',
        data: `$limit: 2.5 * timeline.sourceInfo.samplesInterval;
            { value: timeline.values.[$ > $limit].size(), of: timeline.values.size() }`
    },
    {
        title: 'Time in sample deltas longer than 2.5 intervals', unit: 'us', when: 'timeline',
        definition: 'Sum of the intervals longer than 2.5 nominal sampling intervals.',
        data: `$limit: 2.5 * timeline.sourceInfo.samplesInterval;
            { value: timeline.values.[$ > $limit].sum() or 0, of: timeline.axisTotal }`
    },
    {
        title: 'Inversions of the mapping allocation -> sample', when: 'timeline and memline',
        definition: 'Number of adjacent mapping entries going backwards.',
        data: 'memline.mappings.timeline._mapping | { value: inversions(), of: size() }'
    },
    {
        title: 'Inversions of the mapping sample -> allocation', when: 'timeline and memline',
        definition: 'Number of adjacent mapping entries going backwards.',
        data: 'timeline.mappings.memline._mapping | { value: inversions(), of: size() }'
    },
    {
        title: 'Allocations before the first sample', when: 'timeline and memline',
        definition: 'Assumes allocation ids 1..N; unknown if the mapping is absent, inverted or exceeds N.',
        data: `$window: allocationSampleWindow();
            { value: $window ? $window.start : null, of: memline.sourceInfo.samples }`
    },
    {
        title: 'Allocations after the last sample', when: 'timeline and memline',
        definition: 'Assumes allocation ids 1..N; unknown if the mapping is absent, inverted or exceeds N.',
        data: `$window: allocationSampleWindow(); $total: memline.sourceInfo.samples;
            { value: $window ? $total - $window.end : null, of: $total }`
    },
    {
        title: 'Events without duration', when: 'thread.compilations',
        definition: 'Compilation events which are instant, unfinished or have no start.',
        data: `thread.compilations | {
            value: .[not (tm != null and duration > 0)].size(), of: size()
        }`
    },
    {
        title: 'Events covering at least one allocation', when: 'thread.compilations',
        definition: 'Compilation events with both allocation boundaries and a non-empty range.',
        data: `thread.compilations | { value: .[
            allocationStart != null and allocationEnd != null and allocationEnd > allocationStart
        ].size(), of: size() }`
    },
    {
        title: 'Events with an inverted allocation range', when: 'thread.compilations',
        definition: 'Compilation events whose allocation range ends before it starts.',
        data: `thread.compilations | { value: .[
            allocationStart != null and allocationEnd != null and allocationEnd < allocationStart
        ].size(), of: size() }`
    },
    {
        title: 'Events partially overlapping in time', when: 'thread.compilations',
        definition: 'Events starting inside another event and ending after it.',
        data: 'thread.compilations | { value: eventNesting().partialOverlaps, of: size() }'
    },
    {
        title: 'Allocation range outside of the time parent range', when: 'thread.compilations',
        definition: 'Nested events whose allocation range is not inside the range of the parent.',
        data: `thread.compilations.eventNesting() | {
            value: rangeViolations, of: nestedWithAllocations
        }`
    },
    {
        title: 'Events starting before the sample time axis', when: 'timeline and thread.compilations',
        definition: 'Events with a known start earlier than the start of the profile axis.',
        data: `$start: timeline.axisStart; thread.compilations | {
            value: .[tm != null and tm < $start].size(), of: size()
        }`
    },
    {
        title: 'Events starting after the sample time axis', when: 'timeline and thread.compilations',
        definition: 'Events with a known start later than the end of the profile axis.',
        data: `$end: timeline.axisEnd; thread.compilations | {
            value: .[tm != null and tm > $end].size(), of: size()
        }`
    },
    {
        title: 'The furthest event start from the sample time axis', unit: 'us',
        when: 'timeline and thread.compilations',
        definition: 'Maximum distance of an event start outside the axis; unknown without starts.',
        data: `$start: timeline.axisStart; $end: timeline.axisEnd;
            { value: thread.compilations.[tm != null].([$start - tm, tm - $end, 0].max()).max() }`
    },
    {
        title: 'Allocations with a stage of another event',
        when: 'timeline and memline and thread.compilations',
        definition: 'Stage attribute differs from the innermost event, assuming allocation ids 1..N.',
        data: '{ value: allocationStageMismatches(), of: memline.sourceInfo.samples }'
    }
];
