import { selectProfile, toggleProfile } from './prepare/profile.mts';
import { allConvolutionRule, moduleConvolutionRule, profilePresenceConvolutionRule, setSamplesConvolutionRule, topLevelConvolutionRule } from './prepare/computations/samples-convolution.mjs';
import { allocTimespan, allocTypes, FEATURE_MULTI_PROFILES } from './prepare/const.js';

const demos = discovery.context?.model?.meta?.demos;

if (demos) {
    discovery.action.define('demos', () => demos);
}

discovery.nav.primary.append({
    name: 'github',
    href: 'https://github.com/discoveryjs/cpupro',
    external: true
});
discovery.nav.menu.append({
    when: '#.datasets and #.actions.unloadData',
    content: 'text:"Unload cpuprofile"',
    onClick(_, ctx) {
        ctx.hide();
        ctx.widget.unloadData();
        ctx.widget.setPageHash('');
    }
});

if (FEATURE_MULTI_PROFILES) {
    discovery.nav.before('discovery-page', {
        when: '#.data.profiles.size() > 1 and #.page != "profiles-matrix"',
        text: 'Matrix',
        href: '#profiles-matrix'
    });
}

discovery.action.define('getSessionSetting', (name, defaultValue) => {
    const value = sessionStorage.getItem(name);

    try {
        if (typeof value === 'string') {
            return JSON.parse(value);
        }
    } catch (e) {
        discovery.logger.error(`getSessionSetting: ${e}`);
    }

    return defaultValue;
});
discovery.action.define('setSessionSetting', (name, value) => {
    sessionStorage.setItem(name, JSON.stringify(value) || null);
});
discovery.action.define('selectProfile', (profile) => {
    if (selectProfile(discovery, profile)) {
        discovery.scheduleRender();
    }
});
discovery.action.define('toggleProfile', (profile) => {
    if (toggleProfile(discovery, profile)) {
        discovery.scheduleRender();
    }
});

discovery.action.define('setSamplesConvolutionRule', (newRule) => {
    const { profiles, callFramesProfilePresence } = discovery.data || {};
    const rule = typeof newRule === 'function' ? newRule : null;

    discovery.setContext({ currentSamplesConvolutionRule: rule });

    if (Array.isArray(profiles)) {
        setSamplesConvolutionRule(profiles, callFramesProfilePresence, rule);
        discovery.scheduleRender();
    }
});
discovery.on('data', () => {
    const { currentSamplesConvolutionRule } = discovery.context;

    if (currentSamplesConvolutionRule) {
        const { profiles, callFramesProfilePresence } = discovery.data;

        setSamplesConvolutionRule(profiles, callFramesProfilePresence, currentSamplesConvolutionRule);
    }
});

discovery.action.call('setStructViewAnnotations', [
    '#.key in ["selfTime", "nestedTime", "totalTime"] and $ and { text: duration() }'
]);

discovery.setContext({
    allocationTimespanNames: allocTimespan,
    allocationTypeNames: allocTypes,
    samplesConvolutionRules: {
        all: allConvolutionRule,
        module: moduleConvolutionRule,
        topLevel: topLevelConvolutionRule,
        profilePresence: profilePresenceConvolutionRule
    }
});
