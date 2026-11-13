import type { Profile } from '../prepare/profile.mjs';
import type { ProfileLine, ProfileLineBreakdown } from '../prepare/lines/types.js';
import type { CpuProProcess, CpuProSession, CpuProThread } from '../prepare/types.js';
import { isRange, type Range } from '../prepare/computations/coordinates.js';
import { lineViewport } from './viewport.js';

// What a view shows, as independent elements: owners of the data from a session to a profile, a line (a population
// on its own scale, until populations are addressable apart from lines), a breakdown of the line, a scale the view
// places data on, and the range the view represents on the scale. Each element is relative to its anchors; a
// selected element is within its anchors, an element may be unselected: the data may have no choice to make for it,
// no default for the choice, or nothing to choose from. A scope isn't changed, a view derives a scope for its
// content from the scope of its context
export type ScopeElements = {
    session: CpuProSession | null;
    process: CpuProProcess | null;
    thread: CpuProThread | null;
    profile: Profile | null;
    line: ProfileLine | null;
    breakdown: ProfileLineBreakdown | null;
    scale: ProfileLine | null;
};

export type ScopeElementName = keyof ScopeElements;

export type Scope = ScopeElements & {
    // The requested range or the viewport of the scale, read on each access as the viewport changes
    readonly viewport: Range | null;
    requests: ScopeRequests;
    // Sessions of the data, the choices of a session
    sessions: readonly CpuProSession[];
};

// Requests carried to the anchors of other values: a line type, a breakdown kind and a scale kind select the element
// of the type or kind, the element is unselected where there is none. A range is kept for scales sharing
// its coordinates
export type ScopeRequests = {
    line: string | null;
    breakdown: string | null;
    scale: string | null;
    viewport: Range | null;
};

// A value selects the element and the anchors it implies, a string requests a line type, a breakdown kind
// or a scale kind, null unselects the element. A viewport of null requests the viewport of the scale
export type ScopePatch = {
    [Name in ScopeElementName]?: ScopeElements[Name] | string;
} & {
    viewport?: Range | null;
};

// The first unselected element of the elements a view requires, with the choices for it; no choices is no data
// for it
export type MissingScopeElement = {
    element: ScopeElementName;
    choices: readonly unknown[];
};

type ScopeRequestName = keyof Omit<ScopeRequests, 'viewport'>;

// Members are methods, so an entry takes the type of its own values
type ScopeElement = {
    // Elements the element is relative to, which precede it in the table
    anchors: readonly ScopeElementName[];
    // Anchors a value of the element selects
    implies(value: unknown): Partial<ScopeElements>;
    // Whether a value is within the selected anchors
    fits(value: unknown, elements: ScopeElements): boolean;
    // Choices of the element within the selected anchors
    choices(elements: ScopeElements, sessions: readonly CpuProSession[]): readonly unknown[];
    // The type or kind of a value, which a request selects by; elements without it keep their value while it fits
    kind?(value: unknown): string;
    // A choice of the data when nothing is requested or the value doesn't fit
    preset?(elements: ScopeElements): unknown;
};

const noChoices: readonly never[] = [];

// Elements in the order of their anchors: an element follows the elements it is relative to
const scopeElements: Record<ScopeElementName, ScopeElement> = {
    session: {
        anchors: [],
        implies() {
            return {};
        },
        fits() {
            return true;
        },
        choices(_, sessions) {
            return sessions;
        }
    },
    process: {
        anchors: ['session'],
        implies(process: CpuProProcess) {
            return { session: process.session ?? null };
        },
        fits(process: CpuProProcess, elements) {
            return process.session === elements.session;
        },
        choices(elements) {
            return elements.session?.processes ?? noChoices;
        },
        preset(elements) {
            return elements.session?.defaultProcess ?? null;
        }
    },
    thread: {
        anchors: ['process'],
        implies(thread: CpuProThread) {
            return { process: thread.process ?? null };
        },
        fits(thread: CpuProThread, elements) {
            return thread.process === elements.process;
        },
        choices(elements) {
            return elements.process?.threads ?? noChoices;
        }
    },
    profile: {
        anchors: ['thread'],
        implies(profile: Profile) {
            return { thread: profile.thread ?? null };
        },
        fits(profile: Profile, elements) {
            return profile.thread === elements.thread;
        },
        choices(elements) {
            return elements.thread?.profiles ?? noChoices;
        }
    },
    line: {
        anchors: ['profile'],
        implies(line: ProfileLine) {
            return { profile: line.profile };
        },
        fits(line: ProfileLine, elements) {
            return line.profile === elements.profile;
        },
        choices(elements) {
            return elements.profile?.lines ?? noChoices;
        },
        kind(line: ProfileLine) {
            return line.type;
        }
    },
    breakdown: {
        anchors: ['line'],
        implies(breakdown: ProfileLineBreakdown) {
            return { line: breakdown.line };
        },
        fits(breakdown: ProfileLineBreakdown, elements) {
            return breakdown.line === elements.line;
        },
        choices(elements) {
            return elements.line?.breakdowns ?? noChoices;
        },
        kind(breakdown: ProfileLineBreakdown) {
            return breakdown.kind;
        }
    },
    // A line of the profile whose axis places the line of the scope: its own one or one it maps onto
    scale: {
        anchors: ['profile'],
        implies(scale: ProfileLine) {
            return { profile: scale.profile };
        },
        fits(scale: ProfileLine, elements) {
            const { line } = elements;

            return (
                scale.profile === elements.profile &&
                (line === null || line === scale || line.mappings[scale.type]?.line === scale)
            );
        },
        choices(elements) {
            return elements.profile?.lines ?? noChoices;
        },
        kind(scale: ProfileLine) {
            return scale.kind;
        },
        preset(elements) {
            return elements.line;
        }
    }
};

const scopeElementNames = Object.keys(scopeElements) as ScopeElementName[];

// Lines of time share timestamps, other scales have coordinates of their own
function shareCoordinates(scale: ProfileLine | null, otherScale: ProfileLine | null) {
    return scale === otherScale || (scale?.kind === 'time' && otherScale?.kind === 'time');
}

function createScope(sessions: readonly CpuProSession[], elements: ScopeElements, requests: ScopeRequests): Scope {
    return {
        ...elements,
        get viewport() {
            if (requests.viewport === null && elements.scale !== null) {
                return lineViewport(elements.scale);
            }

            return requests.viewport;
        },
        requests,
        sessions
    };
}

export function createRootScope(
    sessions: readonly CpuProSession[],
    profile: Profile | null,
    lineType: string | null,
    breakdownKind: string | null
) {
    const empty = createScope(
        sessions,
        {
            session: null,
            process: null,
            thread: null,
            profile: null,
            line: null,
            breakdown: null,
            scale: null
        },
        {
            line: lineType,
            breakdown: breakdownKind,
            scale: null,
            viewport: null
        }
    );

    return deriveScope(empty, { profile });
}

export function deriveScope(scope: Scope, patch: ScopePatch): Scope {
    // Filled in the order of the table, so the anchors of an element are there before it
    const elements = {} as ScopeElements;
    const requests = { ...scope.requests };
    const selected = new Map<ScopeElementName, unknown>();

    // Values given select their anchors, a later element of the table decides: a value given for an element
    // a later value selects is dropped, a value whose anchors differ from the ones a later value selects
    // requests its kind
    for (let i = scopeElementNames.length - 1; i >= 0; i--) {
        const name = scopeElementNames[i];
        const element = scopeElements[name];
        const given = patch[name];

        if (element.kind !== undefined && (typeof given === 'string' || given === null)) {
            requests[name as ScopeRequestName] = given;
        }

        if (typeof given !== 'object' || given === null || selected.has(name)) {
            continue;
        }

        const chain = selectionWithAnchors(name, given);
        let fits = true;

        for (const [chainName, value] of chain) {
            if (selected.has(chainName) && selected.get(chainName) !== value) {
                fits = false;
            }
        }

        if (fits) {
            for (const [chainName, value] of chain) {
                selected.set(chainName, value);
            }
        } else if (element.kind !== undefined) {
            requests[name as ScopeRequestName] = element.kind(given);
        }
    }

    // Other elements in the order of the table: an element with a kind is the choice of the requested kind,
    // an element without one keeps its value while it's within the anchors, the data's choice otherwise
    for (let i = 0; i < scopeElementNames.length; i++) {
        const name = scopeElementNames[i];
        const element = scopeElements[name];
        const current = scope[name];
        let value: unknown = null;

        if (selected.has(name)) {
            value = selected.get(name);
        } else if (patch[name] === null) {
            value = null;
        } else if (element.kind !== undefined) {
            value = selectRequested(
                element,
                elements,
                scope.sessions,
                requests[name as ScopeRequestName]
            );
        } else if (current !== null && element.fits(current, elements)) {
            value = current;
        } else {
            value = element.preset?.(elements) ?? null;
        }

        elements[name] = value as never;

        // A selected value is a request of its kind, a choice of the data isn't one
        if (selected.has(name) && value !== null && element.kind !== undefined) {
            requests[name as ScopeRequestName] = element.kind(value);
        }
    }

    if (isRange(patch.viewport)) {
        requests.viewport = patch.viewport;
    } else if ('viewport' in patch || !shareCoordinates(scope.scale, elements.scale)) {
        requests.viewport = null;
    }

    return createScope(scope.sessions, elements, requests);
}

// A value with the anchors it implies, and the anchors they imply in turn
function selectionWithAnchors(name: ScopeElementName, value: unknown) {
    const chain = new Map<ScopeElementName, unknown>([[name, value]]);

    for (let i = scopeElementNames.indexOf(name); i >= 0; i--) {
        const chainName = scopeElementNames[i];
        const chainValue = chain.get(chainName);

        if (chainValue === undefined || chainValue === null) {
            continue;
        }

        const element = scopeElements[chainName];
        const anchors = element.implies(chainValue);

        for (let j = 0; j < element.anchors.length; j++) {
            chain.set(element.anchors[j], anchors[element.anchors[j]]);
        }
    }

    return chain;
}

// The choice of the requested kind within the anchors, the data's choice when nothing is requested
function selectRequested(
    element: ScopeElement,
    elements: ScopeElements,
    sessions: readonly CpuProSession[],
    request: string | null
) {
    const { kind } = element;

    if (request === null || kind === undefined) {
        return element.preset?.(elements) ?? null;
    }

    const choices = element.choices(elements, sessions);

    for (let i = 0; i < choices.length; i++) {
        if (kind(choices[i]) === request && element.fits(choices[i], elements)) {
            return choices[i];
        }
    }

    return null;
}

// The first unselected element of the elements required and their anchors, null when all of them are selected
export function missingScopeElement(scope: Scope, required: ScopeElementName): MissingScopeElement | null {
    const requiredElements = new Set<ScopeElementName>([required]);

    for (let i = scopeElementNames.length - 1; i >= 0; i--) {
        const name = scopeElementNames[i];

        if (requiredElements.has(name)) {
            const { anchors } = scopeElements[name];

            for (let j = 0; j < anchors.length; j++) {
                requiredElements.add(anchors[j]);
            }
        }
    }

    for (let i = 0; i < scopeElementNames.length; i++) {
        const name = scopeElementNames[i];

        if (requiredElements.has(name) && scope[name] === null) {
            return {
                element: name,
                choices: scopeElements[name].choices(scope, scope.sessions)
            };
        }
    }

    return null;
}

export const methods = {
    // A scope for the content of a view: `{ ...#, scope({ line: "timeline" }) }`
    scope(this: { context: { scope: Scope } }, _: unknown, patch: ScopePatch = {}) {
        return deriveScope(this.context.scope, patch);
    }
};
