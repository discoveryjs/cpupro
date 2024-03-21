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

export function isChromiumPerformanceProfile(data: unknown): boolean {
    if (!Array.isArray(data)) {
        // JSON Object Format
        return typeof data === 'object' && data !== null && 'traceEvents' in data
            ? isChromiumPerformanceProfile(data.traceEvents)
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

export function extractFromChromiumPerformanceProfile(
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

    // properties of nodes
    let hasParent = false;

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
                const { nodes, samples } = chunk.cpuProfile;

                if (Array.isArray(nodes) && nodes.length > 0) {
                    cpuProfile.nodes.push(...nodes);

                    if (!hasParent) {
                        hasParent = nodes.find(node => typeof node.parent === 'number');
                    }
                }

                if (samples) {
                    cpuProfile.samples.push(...samples);
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
    let indexToView = -1;

    for (const [profileId, profile] of cpuProfileById) {
        const nodeWithNoChildrenById = new Map<number, CPUProfileNode>();
        const processName: string | null = processNameId.get(parseInt(profileId)) || 'Unknown';

        profile.name = processName;

        if (processName === 'CrRendererMain') {
            indexToView = profiles.length;
        }

        // nodes may missing children field but have parent field, rebuild children arrays then;
        // avoid updating children when nodes have parent and children fields
        if (hasParent) {
            // build map for nodes with no children only
            for (const node of profile.nodes) {
                if (!Array.isArray(node.children) || node.children.length === 0) {
                    nodeWithNoChildrenById.set(node.id, node);
                }
            }

            // rebuild children for nodes which missed it
            if (nodeWithNoChildrenById.size > 0) {
                for (const node of profile.nodes) {
                    if (typeof node.parent === 'number') {
                        const parent = nodeWithNoChildrenById.get(node.parent);

                        if (parent !== undefined) {
                            if (Array.isArray(parent.children)) {
                                parent.children.push(node.id);
                            } else {
                                parent.children = [node.id];
                            }
                        }
                    }
                }
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
