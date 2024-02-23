// See: https://github.com/v8/v8/blob/master/src/inspector/js_protocol.json

type ChromiumTimeline = {
    traceEvents: ChromiumTimelineEvent[]
} & {
    [key: string]: any;
};

interface ChromiumTimelineEvent {
    pid: number;
    tid: number;
    ts: number;
    ph: string;
    cat: string;
    name: string;
    dur: number;
    tdur: number;
    tts: number;
    args: { [key: string]: any };
    id?: string;
}

interface PositionTickInfo {
    line: number;
    ticks: number;
}

interface CPUProfileCallFrame {
    columnNumber: number;
    functionName: string;
    lineNumber: number;
    scriptId: string;
    url: string;
}

interface ProfileGroup {
    indexToView: number;
    profiles: CPUProfile[];
}

export interface CPUProfileNode {
    callFrame: CPUProfileCallFrame;
    hitCount: number;
    id: number;
    children?: number[];
    positionTicks?: PositionTickInfo[];
    parent?: number;
}

export interface CPUProfile {
    name: string;
    startTime: number;
    endTime: number;
    nodes: CPUProfileNode[];
    samples: number[];
    timeDeltas: number[];
}

export function isChromiumTimeline(data: any): boolean {
    if (!Array.isArray(data)) {
        // JSON Object Format
        return data && 'traceEvents' in data
            ? isChromiumTimeline(data.traceEvents)
            : false;
    }

    if (data.length === 0) {
        return true;
    }

    const first = data[0];

    if (!('pid' in first && 'tid' in first && 'ph' in first && 'cat' in first)) {
        return false;
    }

    return true;
}

export function extractCpuProfilesFromChromiumTimeline(
    events: ChromiumTimeline | ChromiumTimelineEvent[]
): ProfileGroup {
    // It seems like sometimes Chrome timeline files contain multiple CpuProfiles?
    // For now, choose the first one in the list.
    const cpuProfileById = new Map<string, CPUProfile>();

    // Maps pid/tid pairs to thread names
    const processNameId = new Map<number, string>();

    // JSON Object Format
    if ('traceEvents' in events) {
        events = events.traceEvents;
    }

    // Filter only necessary events and sort them since the events do not have
    // to be in timestamp-sorted order
    events = events
        .filter(e =>
            e.name === 'CpuProfile' ||
            e.name === 'Profile' ||
            e.name === 'ProfileChunk' ||
            e.name === 'process_name'
        )
        .sort((a, b) => a.ts - b.ts);

    for (const event of events) {
        if (event.name === 'CpuProfile') {
            // Create an arbitrary profile id.
            const profileId = `${event.pid}:0x1`;
            const profile = event.args.data.cpuProfile as CPUProfile;

            cpuProfileById.set(profileId, profile);
            // profile.threadId = event.tid;
        }

        if (event.name === 'Profile') {
            const profileId = `${event.pid}:${event.id}`;
            const profile = {
                name: null,
                startTime: 0,
                endTime: 0,
                nodes: [],
                samples: [],
                timeDeltas: [],
                ...event.args.data
            };
            // profile.threadId = event.tid;

            cpuProfileById.set(profileId, profile);
        }

        if (event.name === 'process_name') {
            processNameId.set(event.pid, event.args.name);
        }

        if (event.name === 'ProfileChunk') {
            const profileId = `${event.pid}:${event.id}`;
            const cpuProfile = cpuProfileById.get(profileId);
            const chunk = event.args.data;

            if (!cpuProfile) {
                console.warn(`Ignoring ProfileChunk for undeclared Profile with id ${profileId}`);
                continue;
            }

            if (chunk.cpuProfile) {
                if (chunk.cpuProfile.nodes) {
                    cpuProfile.nodes.push(...chunk.cpuProfile.nodes);
                }

                if (chunk.cpuProfile.samples) {
                    cpuProfile.samples.push(...chunk.cpuProfile.samples);
                }
            }

            if (chunk.timeDeltas) {
                cpuProfile.timeDeltas.push(...chunk.timeDeltas);
            }

            if (chunk.startTime != null) {
                cpuProfile.startTime = chunk.startTime;
            }

            if (chunk.endTime != null) {
                cpuProfile.endTime = chunk.endTime;
            }
        }
    }

    if (cpuProfileById.size === 0) {
        throw new Error('Could not find CPU profile in Timeline');
    }

    const profiles: CPUProfile[] = [];
    const nodeById = new Map<number, CPUProfileNode>();
    let indexToView = -1;

    for (const [profileId, profile] of cpuProfileById) {
        const processName: string | null = processNameId.get(parseInt(profileId)) || 'Unknown';

        profile.name = processName;

        if (processName === 'CrRendererMain') {
            indexToView = profiles.length;
        }

        for (const node of profile.nodes) {
            node.children = [];
            nodeById.set(node.id, node);
        }

        for (const node of profile.nodes) {
            if (node.parent !== undefined) {
                const parent = nodeById.get(node.parent);

                parent.children.push(node.id);
            }
        }


        if (!profile.endTime && profile.timeDeltas) {
            profile.endTime = profile.timeDeltas.reduce(
                (x, y) => x + y,
                profile.startTime
            );
        }

        profiles.push(profile);
    }

    if (indexToView === -1) {
        indexToView = profiles.reduce(
            (res, profile, idx, array) => array[res].nodes.length < profile.nodes.length ? idx : res,
            0
        );
    }

    return {
        indexToView,
        profiles
    };
}
