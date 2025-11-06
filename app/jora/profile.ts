import { Metric, ProfileLine, ProfileLineType } from '../prepare/lines/types.js';
import { Profile } from '../prepare/profile.mjs';

type Method = (this: { context: MethodContext }, ...args: unknown[]) => unknown;
type MethodContext = {
    primaryLineType: ProfileLineType;
    primaryProfile: Profile | null;
    scopeProfile: Profile | null;
    scopeLine: ProfileLine | null;
    data: null | {
        profiles: Profile[];
    };
};

function isProfile(value: unknown): value is Profile {
    return (
        value !== null &&
        typeof value === 'object' &&
        'callFramesTree' in value &&
        'lines' in value &&
        Array.isArray(value.lines)
    );
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

    return profileLine === profile[profileLine.type];
}

function getScopeProfile(context: MethodContext): Profile | null {
    return context.scopeProfile || context.primaryProfile;
}

export function getProfileOrScopeProfile(profile: unknown, context: MethodContext): Profile | null {
    return isProfile(profile)
        ? profile
        : getScopeProfile(context);
}

export function getProfilePrimaryLine(context: MethodContext, profile: unknown = null): ProfileLine | null {
    const { primaryLineType } = context;
    const targetProfile = getProfileOrScopeProfile(profile, context);

    return targetProfile?.[primaryLineType] ?? null;
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
    scopeProfile() {
        return getScopeProfile(this.context);
    },
    scopeLine() {
        return this.context.scopeLine || getProfilePrimaryLine(this.context);
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
