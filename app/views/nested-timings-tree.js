discovery.view.define('nested-timings-tree', {
    view: 'update-on-timings-change',
    timings: '=timings',
    content: {
        view: 'tree',
        limitLines: 10,
        expanded: false,
        emptyText: 'No nesting calls',
        data: `
            $tree;
            $subject;
            $callFrames: #.data.callFramesTreeTimingsFiltered.nestedTimings(subject, tree);
            $totalTime: $callFrames.sum(=> selfTime);

            $callFrames
                .({ callFrame: entry, time: selfTime, total: $totalTime })
                .sort(time desc)
                .group(=> callFrame.module)
                    .({ module: key, time: value.sum(=> time), total: $totalTime, callFrames: value })
                    .sort(time desc)
                .group(=> module.package)
                    .({ package: key, time: value.sum(=> time), total: $totalTime, modules: value })
                    .sort(time desc)
        `,
        itemConfig: {
            content: ['package-badge:package', 'duration'],
            children: 'modules',
            itemConfig: {
                content: ['module-badge:module', 'duration'],
                children: 'callFrames',
                itemConfig: {
                    content: ['call-frame-badge:callFrame', 'duration']
                }
            }
        }
    }
});
