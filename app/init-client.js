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
    className: 'github',
    content: 'text:"GitHub"',
    data: { href: 'https://github.com/discoveryjs/cpupro' }
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

// FIXME: temporary solution, since context is cleaning up on data load/unload
discovery.on('data', () => setTimeout(consumeDemos, 1));
setTimeout(consumeDemos, 1);
