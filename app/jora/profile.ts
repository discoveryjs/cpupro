import { Metric, ProfileLine, ProfileLineBreakdown, ProfileLineType } from '../prepare/lines/types.js';
import { Profile } from '../prepare/profile.mjs';

type Method = (this: { context: MethodContext }, ...args: unknown[]) => unknown;
type MethodContext = {
    primaryProfile: Profile | null;
    primaryLineType: ProfileLineType;
    primaryBreakdownKind: string | null;
    scopeProfile: Profile | null;
    scopeLine: ProfileLine | null;
    scopeBreakdown: ProfileLineBreakdown | null;
    data: null | {
        profiles: Profile[];
    };
};

function isProfile(value: unknown): value is Profile {
    return (
        value !== null &&
        typeof value === 'object' &&
        'runtime' in value &&
        'lines' in value &&
        Array.isArray(value.lines)
    );
}

function findProfileLine(profile: Profile, lineType: string | null = null): ProfileLine | null {
    return profile.lines.find(line => !lineType || line.type === lineType) ?? null;
}

function isProfileLine(line: unknown): line is ProfileLine {
    if (!line || typeof line !== 'object') {
        return false;
    }

    const profileLine = line as ProfileLine;
    const profile = profileLine.profile;

    if (!isProfile(profile)) {
        return false;
    }

    return profileLine === findProfileLine(profile, profileLine.type);
}

function findProfileLineBreakdown(line: ProfileLine, breakdownKind: string | null = null): ProfileLineBreakdown | null {
    return line.breakdowns.find(breakdown => !breakdownKind || breakdown.kind === breakdownKind) ?? null;
}

function isProfileLineBreakdown(breakdown: unknown): breakdown is ProfileLineBreakdown {
    if (!breakdown || typeof breakdown !== 'object') {
        return false;
    }

    const lineBreakdown = breakdown as ProfileLineBreakdown;
    const line = lineBreakdown.line;

    if (!isProfileLine(line)) {
        return false;
    }

    return lineBreakdown === findProfileLineBreakdown(line, lineBreakdown.kind);
}

function getScopeProfile(context: MethodContext): Profile | null {
    return context.scopeProfile || context.primaryProfile;
}

export function getProfileOrScopeProfile(profile: unknown, context: MethodContext): Profile | null {
    return isProfile(profile)
        ? profile
        : getScopeProfile(context);
}

export function getProfilePrimaryLine(context: MethodContext, profile: unknown = null, lineType: string | null = null): ProfileLine | null {
    const targetProfile = getProfileOrScopeProfile(profile, context);

    return targetProfile && findProfileLine(
        targetProfile,
        typeof lineType === 'string' ? lineType : context.primaryLineType
    );
}

export function getProfileLineBreakdown(context: MethodContext, line: unknown = null, breakdownKind: string | null = null): ProfileLineBreakdown | null {
    const targetLine = resolveScopeProfileLine(line, context);

    return targetLine && findProfileLineBreakdown(
        targetLine,
        typeof breakdownKind === 'string' ? breakdownKind : context.primaryBreakdownKind
    );
}

export function resolveScopeProfileLine(
    line: unknown,
    context: MethodContext
): ProfileLine | null {
    let resolvedLine: ProfileLine | null = null;

    if (!line) {
        resolvedLine = context.scopeLine || getProfilePrimaryLine(context);
    } else if (typeof line === 'string') {
        resolvedLine = getScopeProfile(context)?.[line] ?? null;
    } else if (isProfileLine(line)) {
        resolvedLine = line;
    }

    return resolvedLine;
}

export function resolveScopeProfileLineBreakdown(
    breakdown: unknown,
    line: unknown,
    context: MethodContext
): ProfileLineBreakdown | null {
    let resolvedBreakdown: ProfileLineBreakdown | null = null;

    if (!breakdown) {
        resolvedBreakdown = context.scopeBreakdown || getProfileLineBreakdown(context, line);
    } else if (typeof breakdown === 'string') {
        resolvedBreakdown = resolveScopeProfileLine(line, context)?.breakdowns
            .find(p => p.kind === breakdown) ?? null;
    } else if (isProfileLineBreakdown(breakdown)) {
        resolvedBreakdown = breakdown;
    }

    return resolvedBreakdown;
}

export const assertions: Record<string, Method> = {
    profile(profile: unknown) {
        return this.context.data?.profiles.includes(profile as Profile) || false;
    },
    primaryLine(line: unknown) {
        return isProfileLine(line) && line.type === this.context.primaryLineType;
    },
    secondaryLine(line: unknown) {
        return isProfileLine(line) && line.type !== this.context.primaryLineType;
    }
};

export const methods: Record<string, Method> = {
    scopeProfile() {
        return getScopeProfile(this.context);
    },
    scopeLine(_: unknown, lineType: string | null = null) {
        return this.context.scopeLine || getProfilePrimaryLine(this.context, null, lineType);
    },
    scopeBreakdown(_: unknown, breakdownKind: string | null = null) {
        return this.context.scopeBreakdown || getProfileLineBreakdown(this.context, null, breakdownKind);
    },
    primaryLine(profile: Profile) {
        return getProfilePrimaryLine(this.context, profile);
    },
    secondaryLine(profile: Profile, lineType: ProfileLineType) {
        const { primaryLineType } = this.context;
        const targetProfile = getProfileOrScopeProfile(profile, this.context);

        return targetProfile?.lines.find(line =>
            lineType ? line.type === lineType : line.type !== primaryLineType
        ) ?? null;
    },
    primaryBreakdown(line: ProfileLine) {
        return getProfileLineBreakdown(this.context, line);
    },
    metricName(metric: Metric, line?: ProfileLine | ProfileLineType) {
        return resolveScopeProfileLine(line, this.context)?.metricName(metric);
    },
    metricDefinition(metric: Metric, line?: ProfileLine | ProfileLineType) {
        return resolveScopeProfileLine(line, this.context)?.metricDefinition(metric);
    },
    formatValue(value: number, line?: ProfileLine | ProfileLineType) {
        return resolveScopeProfileLine(line, this.context)?.formatValue(value);
    },
    valueAndUnit(value: number, line?: ProfileLine | ProfileLineType) {
        return resolveScopeProfileLine(line, this.context)?.valueWithUnit(value);
    },
    totalMetricPercent(value: number, prec = 2, line?: ProfileLine | ProfileLineType) {
        const total = resolveScopeProfileLine(line, this.context)?.axisTotal ?? 1; // the method can be invoked in struct annotation context
        const percent = 100 * value / total;
        const min = 1 / Math.pow(10, Number(prec || 1));
        return percent >= min ? percent.toFixed(Number(prec || 1)) + '%' : percent !== 0 ? '<' + min + '%' : '0%';
    },
    // legacy alias
    unit(value: number) {
        return resolveScopeProfileLine(null, this.context)?.formatValue(value);
    }
};
