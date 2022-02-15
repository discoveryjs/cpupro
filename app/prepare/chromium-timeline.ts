// See: https://github.com/v8/v8/blob/master/src/inspector/js_protocol.json

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
    name: string;
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

function isProfileRelatedEvent(e) {
    return (
        e.name === 'CpuProfile' ||
        e.name === 'Profile' ||
        e.name === 'ProfileChunk'
    );
}

export function isChromiumTimeline(rawProfile: any): boolean {
    if (!Array.isArray(rawProfile) || rawProfile.length === 0) {
        return false;
    }

    const first = rawProfile[0]

    if (!('pid' in first && 'tid' in first && 'ph' in first && 'cat' in first)) {
        return false;
    }

    if (!rawProfile.find(isProfileRelatedEvent)) {
        return false;
    }

    return true;
}
        
export function extractCpuProfilesFromChromiumTimeline(events: ChromiumTimelineEvent[], fileName: string): ProfileGroup {
    // It seems like sometimes Chrome timeline files contain multiple CpuProfiles?
    // For now, choose the first one in the list.
    const cpuProfileByID = new Map<string, CPUProfile>();

    // Maps profile IDs (like "0x3") to pid/tid pairs formatted as `${pid}:${tid}`
    const pidTidById = new Map<string, string>();

    // Maps pid/tid pairs to thread names
    const threadNameByPidTid = new Map<string, string>();

    // The events aren't necessarily recorded in chronological order. Sort them so
    // that they are.
    events.sort((a, b) => a.ts - b.ts);

    for (let event of events) {
        if (event.name === 'CpuProfile') {
            const pidTid = `${event.pid}:${event.tid}`;
            const id = event.id || pidTid;

            cpuProfileByID.set(id, event.args.data.cpuProfile as CPUProfile);
            pidTidById.set(id, pidTid);
        }
        
        if (event.name === 'Profile') {
            const pidTid = `${event.pid}:${event.tid}`;

            cpuProfileByID.set(event.id || pidTid, {
                name: null,
                startTime: 0,
                endTime: 0,
                nodes: [],
                samples: [],
                timeDeltas: [],
                ...event.args.data
            });
            
            if (event.id) {
                pidTidById.set(event.id, pidTid);
            }
        }
        
        if (event.name === 'thread_name') {
            threadNameByPidTid.set(`${event.pid}:${event.tid}`, event.args.name);
        }
        
        if (event.name === 'ProfileChunk') {
            const pidTid = `${event.pid}:${event.tid}`;
            const cpuProfile = cpuProfileByID.get(event.id || pidTid);

            if (cpuProfile) {
                const chunk = event.args.data;

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
            } else {
                console.warn(`Ignoring ProfileChunk for undeclared Profile with id ${event.id || pidTid}`);
            }
        }
    }

    if (cpuProfileByID.size === 0) {
        throw new Error('Could not find CPU profile in Timeline');
    }

    const profiles: CPUProfile[] = [];
    const nodeById = new Map<number, CPUProfileNode>();
    let indexToView = 0;
    
    for (const [profileId, profile] of cpuProfileByID) {
        let pidTid = pidTidById.get(profileId);
        let threadName: string | null = threadNameByPidTid.get(pidTid) || null;

        for (const node of profile.nodes) {
            node.children = [];
            nodeById.set(node.id, node);
        }

        for (const node of profile.nodes) {
            if (node.parent !== undefined) {
                const parent = nodeById.get(node.parent)
                parent.children.push(node.id);
            }
        }

        if (threadName && cpuProfileByID.size > 1) {
            profile.name = `${fileName} - ${threadName}`;

            if (threadName === 'CrRendererMain') {
                indexToView = profiles.length;
            }
        } else {
            profile.name = fileName;
        }

        profiles.push(profile);
    }
    
    return {
        name: fileName,
        indexToView,
        profiles
    };
}
