import { utils } from '@discoveryjs/discovery';
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
        when: '#.data.defaultSession.processes.threads.[events] and #.page != "events"',
        text: 'Events',
        href: '#events'
    });
    // model.nav.before('discovery-page', {
    //     when: '#.data.profiles.size() > 1 and #.page != "profiles-matrix"',
    //     text: 'Matrix',
    //     href: '#profiles-matrix'
    // });
}

const appbarEl = utils.createElement('div', 'discovery-appbar');
const renderAppbar = () => {
    appbarEl.replaceChildren();
    model.view.render(appbarEl, 'appbar', model.data, model.getContext());
};
const sheduleAppbarRender = utils.debounce(renderAppbar, 100);
model.dom.container.prepend(appbarEl);
model.on('context', sheduleAppbarRender);
model.on('data', sheduleAppbarRender);

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

model.action.call('setStructViewAnnotations', [
    '#.key in ["selfValue", "nestedValue", "totalValue"] and $ and { text: duration() }'
]);
