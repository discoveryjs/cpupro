function consumeDemos() {
    const demos = discovery.context?.model?.meta?.demos;

    if (demos) {
        discovery.action.define('demos', () => demos);

        if (discovery.data) {
            discovery.cancelScheduledRender();
        }
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
