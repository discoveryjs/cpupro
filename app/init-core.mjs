import { toggleProfile } from './prepare/profile.mts';
import { allConvolutionRule, moduleConvolutionRule, profilePresenceConvolutionRule, setSamplesConvolutionRule, topLevelConvolutionRule } from './prepare/computations/samples-convolution.mjs';

const model = discovery;

model.action.define('selectProfile', (profile) => {
    model.setContext({
        primaryProfile: profile
    });
});
model.action.define('selectPrimaryLine', (lineType) => {
    model.setContext({
        primaryLineType: lineType
    });
    try {
        sessionStorage.setItem('cpupro:primary-line-type', lineType);
    } catch {}
});
model.action.define('selectPrimaryTree', (treeKind) => {
    model.setContext({
        primaryTreeKind: treeKind
    });
    try {
        sessionStorage.setItem('cpupro:primary-tree-kind', treeKind);
    } catch {}
});
model.action.define('toggleProfile', (profile) => {
    if (toggleProfile(model, profile)) {
        model.scheduleRender?.();
    }
});

model.action.define('setSamplesConvolutionRule', (newRule) => {
    const { profiles, callFramesProfilePresence } = model.data || {};
    const rule = typeof newRule === 'function' ? newRule : null;

    model.setContext({ currentSamplesConvolutionRule: rule });

    if (Array.isArray(profiles)) {
        setSamplesConvolutionRule(profiles, callFramesProfilePresence, rule);
        model.scheduleRender?.();
    }
});
model.on('unloadData', () => {
    model.setContext({
        buckets: [],
        profiles: [],
        primaryProfile: null,
        // primaryLineType: null, // keep selected line type
        // primaryTreeKind: null, // keep selected tree kind
        scopeProfile: null, // always null by default, views can override it
        scopeLine: null,
        scopeTree: null
    });
});
model.on('data', () => {
    const { currentSamplesConvolutionRule } = model.context;
    const { defaultProfile, profiles } = model.data;
    let primaryLineType = model.context.primaryLineType || null;
    let primaryTreeKind = model.context.primaryTreeKind || null;

    if (!primaryLineType) {
        try {
            primaryLineType = sessionStorage.getItem('cpupro:primary-line-type');
        } catch {}
    }

    if (!primaryLineType || !profiles.some(profile => profile.lines.find(line => line.type === primaryLineType))) {
        primaryLineType = defaultProfile?.lines?.[0].type || null;
    }

    const primaryLine = defaultProfile?.lines.find(line => line.type === primaryLineType);

    if (!primaryTreeKind) {
        try {
            primaryTreeKind = sessionStorage.getItem('cpupro:primary-tree-kind');
        } catch {}
    }

    if (!primaryTreeKind || !primaryLine?.trees?.some(tree => tree.kind === primaryTreeKind)) {
        primaryTreeKind = primaryLine?.trees?.[0]?.kind || null;
    }

    const primaryBucket = {
        name: 'primary',
        mode: 'unknown',
        lines: []
    };
    const secondaryBucket = {
        name: 'secondary',
        mode: 'unknown',
        lines: []
    };

    model.setContext({
        buckets: [primaryBucket, secondaryBucket],
        profiles: Array.from(profiles || [], profile => ({
            disabled: false,
            bucket: primaryBucket,
            profile
        })),
        primaryProfile: defaultProfile,
        primaryLineType,
        primaryTreeKind,
        scopeProfile: null, // always null by default, views can override it
        scopeLine: null,    // always null by default, views can override it
        scopeTree: null     // always null by default, views can override it
    });

    if (currentSamplesConvolutionRule) {
        const { profiles, callFramesProfilePresence } = model.data;

        setSamplesConvolutionRule(profiles, callFramesProfilePresence, currentSamplesConvolutionRule);
    }
});

// discovery.action.call('setSamplesConvolutionRule', (self) => {
//     const { kind } = self.entry;

//     return (
//         kind === 'ic' ||
//         kind === 'bytecode' ||
//         kind === 'builtin' ||
//         kind === 'cpp' ||
//         kind === 'lib'
//     );
// });

model.setContext({
    samplesConvolutionRules: {
        all: allConvolutionRule,
        module: moduleConvolutionRule,
        topLevel: topLevelConvolutionRule,
        profilePresence: profilePresenceConvolutionRule
    }
});
