import { toggleProfile } from './prepare/profile.mts';
import { allConvolutionRule, moduleConvolutionRule, profilePresenceConvolutionRule, setSamplesConvolutionRule, topLevelConvolutionRule } from './prepare/computations/samples-convolution.mjs';
import { FEATURE_MULTI_PROFILES } from './prepare/const.js';

const model = discovery;
const demos = model.context?.model?.meta?.demos;

if (demos) {
    model.action.define('demos', () => demos);
}

model.nav.primary.append({
    name: 'github',
    href: 'https://github.com/discoveryjs/cpupro',
    external: true
});
model.nav.menu.append({
    when: '#.datasets and #.actions.unloadData',
    content: 'text:"Unload cpuprofile"',
    onClick(_, ctx) {
        ctx.hide();
        ctx.widget.unloadData();
        ctx.widget.setPageHash('');
    }
});

if (FEATURE_MULTI_PROFILES) {
    model.nav.before('discovery-page', {
        when: '#.data.profiles.size() > 1 and #.page != "profiles-matrix"',
        text: 'Matrix',
        href: '#profiles-matrix'
    });
}

model.action.define('getSessionSetting', (name, defaultValue) => {
    const value = sessionStorage.getItem(name);

    try {
        if (typeof value === 'string') {
            return JSON.parse(value);
        }
    } catch (e) {
        model.logger.error(`getSessionSetting: ${e}`);
    }

    return defaultValue;
});
model.action.define('setSessionSetting', (name, value) => {
    sessionStorage.setItem(name, JSON.stringify(value) || null);
});
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
        model.scheduleRender();
    }
});

model.action.define('setSamplesConvolutionRule', (newRule) => {
    const { profiles, callFramesProfilePresence } = model.data || {};
    const rule = typeof newRule === 'function' ? newRule : null;

    model.setContext({ currentSamplesConvolutionRule: rule });

    if (Array.isArray(profiles)) {
        setSamplesConvolutionRule(profiles, callFramesProfilePresence, rule);
        model.scheduleRender();
    }
});
model.on('unloadData', () => {
    model.setContext({
        // primaryLineType: null, // keep selected line type
        primaryProfile: null
    });
});
model.on('data', () => {
    const { defaultLineType, currentSamplesConvolutionRule } = model.context;
    const { defaultProfile, profiles } = model.data;
    let primaryLineType = defaultLineType || null;

    if (!primaryLineType || !profiles.some(profile => profile.lines.includes(primaryLineType))) {
        primaryLineType = defaultProfile?.defaultLineType;
    }

    model.setContext({
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

model.action.call('setStructViewAnnotations', [
    '#.key in ["selfValue", "nestedValue", "totalValue"] and $ and { text: duration() }'
]);

model.setContext({
    samplesConvolutionRules: {
        all: allConvolutionRule,
        module: moduleConvolutionRule,
        topLevel: topLevelConvolutionRule,
        profilePresence: profilePresenceConvolutionRule
    }
});
