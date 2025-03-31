import { selectProfile, toggleProfile } from './prepare/profile.mts';
import { allConvolutionRule, moduleConvolutionRule, profilePresenceConvolutionRule, setSamplesConvolutionRule, topLevelConvolutionRule } from './prepare/computations/samples-convolution.mjs';
import { allocTimespan, allocTypes, FEATURE_MULTI_PROFILES } from './prepare/const.js';

const demos = discovery.context?.model?.meta?.demos;

if (demos) {
    discovery.action.define('demos', () => demos);
}

discovery.nav.primary.append({
    name: 'github',
    text: 'GitHub',
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

discovery.action.define('setSamplesConvolutionRule', (rule) => {
    const { profiles, callFramesProfilePresence } = discovery.data;

    if (Array.isArray(profiles)) {
        const newRule = typeof rule === 'function' ? rule : null;

        setSamplesConvolutionRule(profiles, callFramesProfilePresence, newRule);
        discovery.data = { ...discovery.data, currentSamplesConvolutionRule: newRule };
        discovery.scheduleRender();
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
