discovery.view.define('nested-timings-tree', {
    view: 'draft-timings-related',
    source: '=timings',
    content: {
        view: 'tree',
        limitLines: 10,
        data: `
            $tree;
            $subject;
            $functions: $tree.nestedTimings($subject, #.data.functionsTree);
            $totalTime: $functions.sum(=>selfTime);

            $functions
                .({ function: entry, time: selfTime, total: $totalTime })
                .sort(time desc)
                .group(=>function.module)
                    .({ module: key, time: value.sum(=>time), total: $totalTime, functions: value })
                    .sort(time desc)
                .group(=>module.package)
                    .({ package: key, time: value.sum(=>time), total: $totalTime, modules: value })
                    .sort(time desc)
        `,
        expanded: false,
        itemConfig: {
            content: ['package-badge:package', 'duration'],
            children: 'modules',
            itemConfig: {
                content: ['module-badge:module', 'duration'],
                children: 'functions',
                itemConfig: {
                    content: ['function-badge:function', 'duration']
                }
            }
        }
    }
});
