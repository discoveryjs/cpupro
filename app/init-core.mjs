import { toggleProfile } from './prepare/profile.mts';
import { allConvolutionRule, moduleConvolutionRule, profilePresenceConvolutionRule, setSamplesConvolutionRule, topLevelConvolutionRule } from './prepare/computations/samples-convolution.mjs';

const model = discovery;

model.action.define('selectPrimaryLine', (lineType) => {
    model.setContext({
        primaryLineType: lineType
    });
});
model.action.define('selectProfile', (profile) => {
    model.setContext({
        primaryProfile: profile
    });
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
        scopeProfile: null, // always null by default, views can override it
        scopeLine: null
    });
});
model.on('data', () => {
    const { defaultLineType, currentSamplesConvolutionRule } = model.context;
    const { defaultProfile, profiles } = model.data;
    let primaryLineType = defaultLineType || null;

    if (!primaryLineType || !profiles.some(profile => profile.lines.includes(primaryLineType))) {
        primaryLineType = defaultProfile?.defaultLineType;
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
        scopeProfile: null, // always null by default, views can override it
        scopeLine: null     // always null by default, views can override it
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
