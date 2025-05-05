import { createElement } from '@discoveryjs/discovery/utils';

discovery.view.define('call-frame-inlined-matrix', function(el, props, data, context) {
    const { tree, snapshots } = data;
    const treeEl = el.appendChild(createElement('div', 'call-frame-tree'));
    const shapshotsRowsEl = el.appendChild(createElement('div', 'snapshots-rows'));
    const rowsCount = snapshots[0].presence.length;
    const renders = [
        this.render(treeEl, {
            view: 'tree',
            expanded: 100,
            collapsible: false,
            item: ['call-frame-badge:value.callFrame']
        }, tree, context)
    ];

    for (const snapshot of snapshots) {
        const headerCellEl = shapshotsRowsEl.appendChild(createElement('div', 'snapshot-header-cell'));

        renders.push(this.render(headerCellEl, [
            {
                view: 'block',
                className: 'codes-range',
                content: 'text:start = end ? start : `${start}…${end}`'
            },
            {
                view: 'inline-list',
                className: 'code-tier-list',
                data: 'codes.tier',
                itemConfig: 'code-tier-badge'
            }
        ], snapshot, context));
    }

    for (let i = 0; i < rowsCount; i++) {
        for (const snapshot of snapshots) {
            shapshotsRowsEl.append(createElement('div', snapshot.presence[i] ? 'snapshot-cell present' : 'snapshot-cell missed'));
        }
    }

    shapshotsRowsEl.style.setProperty('--snapshot-count', snapshots.length);
    el.append(
        treeEl,
        shapshotsRowsEl
    );

    return Promise.all(renders);
});
