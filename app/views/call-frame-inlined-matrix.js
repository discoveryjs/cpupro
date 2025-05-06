import { createElement } from '@discoveryjs/discovery/utils';

discovery.view.define('call-frame-inlined-matrix', function(el, props, data, context) {
    const { tree, snapshots, mergeSnapshots = true } = data;
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
    const mergedSnapshots = [];
    let prevSnapshot = null;

    for (let i = 0; i < snapshots.length; i++) {
        const snapshot = snapshots[i];
        const currentSnapshot = mergeSnapshots && prevSnapshot?.hash === snapshot.hash
            ? prevSnapshot
            : {
                hash: snapshot.hash,
                presence: snapshot.presence,
                start: i,
                end: i,
                codes: []
            };

        currentSnapshot.end = i;
        currentSnapshot.codes.push(snapshot.code);

        if (currentSnapshot !== prevSnapshot) {
            mergedSnapshots.push(currentSnapshot);
            prevSnapshot = currentSnapshot;
        }
    }

    for (const snapshot of mergedSnapshots) {
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
        for (const snapshot of mergedSnapshots) {
            shapshotsRowsEl.append(createElement('div', snapshot.presence[i] ? 'snapshot-cell present' : 'snapshot-cell missed'));
        }
    }

    shapshotsRowsEl.style.setProperty('--snapshot-count', mergedSnapshots.length);
    el.append(
        treeEl,
        shapshotsRowsEl
    );

    return Promise.all(renders);
});
