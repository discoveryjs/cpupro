discovery.view.define('nested-timings-tree', {
    view: 'update-on-line-metrics-changes',
    metrics: '=metrics',
    content: {
        view: 'tree',
        limitLines: 10,
        expanded: false,
        emptyText: 'No nested calls',
        data: `
            $tree;
            $subject;
            $callFrames: scopeLine().tree.callFrames.filtered.nestedValues(subject, tree);
            $totalValue: $callFrames.sum(=> selfValue);

            $callFrames
                .({ callFrame: entry, value: selfValue, total: $totalValue })
                .sort(value desc)
                .group(=> callFrame.module)
                    .({ module: key, value: value.sum(=> value), total: $totalValue, callFrames: value })
                    .sort(value desc)
                .group(=> module.package)
                    .({ package: key, value: value.sum(=> value), total: $totalValue, modules: value })
                    .sort(value desc)
        `,
        itemConfig: {
            content: ['package-badge:package', 'metric'],
            children: 'modules',
            itemConfig: {
                content: ['module-badge:module', 'metric'],
                children: 'callFrames',
                itemConfig: {
                    content: ['call-frame-badge:callFrame', 'metric']
                }
            }
        }
    }
});
