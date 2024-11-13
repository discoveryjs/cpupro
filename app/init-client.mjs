import { selectProfile, toggleProfile } from './prepare/profile.mts';
import { allConvolutionRule, moduleConvolutionRule, profilePresenceConvolutionRule, setSamplesConvolutionRule } from './prepare/computations/samples-convolution.mjs';

function consumeDemos() {
    const demos = discovery.context?.model?.meta?.demos;

    if (demos) {
        discovery.action.define('demos', () => demos);

        if (discovery.data) {
            discovery.cancelScheduledRender();
        }
    }

    if (discovery.context) {
        discovery.context.samplesConvolutionRules = {
            all: allConvolutionRule,
            module: moduleConvolutionRule,
            profilePresence: profilePresenceConvolutionRule
        };
    }
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

    if (Array.isArray(profiles)) {
        selectProfile(discovery, profile);
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

// FIXME: temporary solution
try {
    discovery.annotations.push({
        query: '#.key in ["selfTime", "nestedTime", "totalTime"] and $ and { text: duration() }'
    });
} catch (e) {
    console.error(e);
}

// FIXME: temporary solution, since context is not set on App's init
setTimeout(consumeDemos, 1);
discovery.once('data', () => setTimeout(consumeDemos, 1));
