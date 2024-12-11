import { selectProfile, toggleProfile } from './prepare/profile.mts';
import { allConvolutionRule, moduleConvolutionRule, profilePresenceConvolutionRule, setSamplesConvolutionRule, topLevelConvolutionRule } from './prepare/computations/samples-convolution.mjs';

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

discovery.action.define('selectProfile', (profile) => {
    const { profiles } = discovery.data;

    if (Array.isArray(profiles) && selectProfile(discovery, profile)) {
        discovery.scheduleRender();
    }
});
discovery.action.define('toggleProfile', (profile) => {
    const { profiles } = discovery.data;

    if (Array.isArray(profiles)) {
        toggleProfile(discovery, profile);
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
    samplesConvolutionRules: {
        all: allConvolutionRule,
        module: moduleConvolutionRule,
        topLevel: topLevelConvolutionRule,
        profilePresence: profilePresenceConvolutionRule
    }
});
