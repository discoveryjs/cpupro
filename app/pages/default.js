/* eslint-env node */
const demoDataBase64 = require('../demo-data-base64.js').default;
let fullpageMode = false;

discovery.action.define('uploadDemoData', () => discovery.loadDataFromUrl(demoDataBase64));
setTimeout(() => {
    discovery.nav.primary.append({
        className: 'github',
        content: 'text:"GitHub"',
        data: { href: 'https://github.com/lahmatiy/cpupro' }
    });
    discovery.nav.primary.append({
        className: 'full-page-mode',
        content: 'text:"Exit full page"',
        when: () => fullpageMode,
        onClick: toggleFullPageFlamechart
    });
    discovery.nav.menu.append({
        when: true,
        content: 'text:"Unload cpuprofile"',
        onClick(_, ctx) {
            ctx.hide();
            ctx.widget.unloadData();
            ctx.widget.setPageHash('');
        }
    });
    discovery.nav.render(discovery.dom.nav, discovery.data, discovery.getRenderContext());
}, 1);

function toggleFullPageFlamechart() {
    // const params = { ...discovery.pageParams };

    // if (enabled) {
    //     params.fullScreen = true;
    // } else {
    //     delete params.fullScreen;
    // }

    // discovery.setPageParams(params);
    // discovery.cancelScheduledRender();
    fullpageMode = discovery.dom.container.classList.toggle('flamecharts-fullpage');
    discovery.nav.render(discovery.dom.nav, discovery.data, discovery.getRenderContext());

    const toggleEl = discovery.dom.container.querySelector('.flamechart-fullpage-toggle');
    toggleEl.classList.toggle('checked');
    // toggleEl.scrollIntoView(true);

    // use timeout since on scroll handler may disable scrolling
    setTimeout(() => {
        const flamechartEl = discovery.dom.container.querySelector('.flamecharts .view-flamechart');
        flamechartEl.classList.toggle(
            'disable-scrolling',
            !fullpageMode && flamechartEl.firstChild.scrollTop === 0
        );
    });
}

const areasTimeBars = {
    view: 'timing-bar',
    data: `areas.({
        text: name,
        duration: selfTime,
        color: name.color(),
        href: marker("area").href
    }).sort(duration desc)`,
    segment: {
        tooltip: [
            'text:text',
            'duration:{ time: duration, total: #.data.totalTime }'
        ]
    }
};

const areasTimeline = {
    view: 'block',
    className: 'area-timelines',
    content: [
        'time-ruler{ duration: #.data.totalTime, captions: "top" }',
        {
            view: 'list',
            className: 'area-timelines-list',
            data: 'areas.[selfTime]',
            item: {
                view: 'link',
                className: 'area-timelines-item',
                data: '{ area: $, href: marker("area").href }',
                content: [
                    'duration:{ time: area.selfTime, total: #.data.totalTime }',
                    {
                        view: 'block',
                        className: 'label',
                        content: 'text:area.name | $ != "garbage collector" ?: "gc"'
                    },
                    {
                        view: 'timeline-segments-bin',
                        bins: '=binCalls(#.data.areasTree, area, 500)',
                        max: '=#.data.totalTime / 500',
                        binsMax: true,
                        color: '=area.name.color()'
                    }
                ],
                tooltip: [
                    'text:area.name',
                    'duration:{ time: area.selfTime, total: #.data.totalTime }'
                ]
            }
        }
    ]
};

const packagesList = {
    view: 'section',
    when: 'packages.size() > 1',
    header: [
        'text:"Packages & areas "',
        { view: 'badge', content: 'text-numeric:packages.size()' }
    ],
    content: {
        view: 'content-filter',
        content: {
            view: 'table',
            data: 'packages.sort(selfTime desc, totalTime desc).[name ~= #.filter]',
            limit: 15,
            cols: [
                { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                { header: 'Package', className: 'main', sorting: 'name asc', content: 'package-badge' }
            ]
        }
    }
};

const modulesList = {
    view: 'section',
    header: [
        'text:"Modules "',
        { view: 'badge', content: 'text-numeric:modules.size()' }
    ],
    content: {
        view: 'content-filter',
        content: {
            view: 'table',
            data: 'modules.sort(selfTime desc, totalTime desc).[(name or (package.name + "/" + packageRelPath)) ~= #.filter]',
            limit: 15,
            cols: [
                { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                { header: 'Module', className: 'main', sorting: '(name or (package.name + "/" + packageRelPath)) ascN', content: 'module-badge' }
            ]
        }
    }
};

const functionList = {
    view: 'section',
    header: [
        'text:"Functions "',
        { view: 'badge', content: 'text-numeric:functions.size()' }
    ],
    content: {
        view: 'content-filter',
        content: {
            view: 'table',
            data: 'functions.sort(selfTime desc, totalTime desc).[name ~= #.filter]',
            limit: 15,
            cols: [
                { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                { header: 'Function', className: 'main', sorting: 'name ascN', content: 'function-badge' }
            ]
        }
    }
};

const flamecharts = {
    view: 'context',
    modifiers: {
        view: 'block',
        className: 'toolbar',
        content: [
            {
                view: 'toggle-group',
                name: 'dataset',
                data: [
                    { text: 'Areas', value: 'areasTree' },
                    { text: 'Packages', value: 'packagesTree', active: true },
                    { text: 'Modules', value: 'modulesTree' },
                    { text: 'Functions', value: 'functionsTree' }
                ]
            },
            {
                view: 'block',
                className: 'filters',
                content: [
                    {
                        view: 'checkbox',
                        name: 'showIdle',
                        checked: true,
                        content: 'text:"(idle)"',
                        tooltip: {
                            showDelay: true,
                            className: 'hint-tooltip',
                            content: 'md:"Time when the engine is waiting for tasks or not actively executing any JavaScript code. This could be due to waiting for I/O operations, timer delays, or simply because there\'s no code to execute at that moment."'
                        }
                    },
                    {
                        view: 'checkbox',
                        name: 'showProgram',
                        checked: true,
                        content: 'text:"(program)"',
                        tooltip: {
                            showDelay: true,
                            className: 'hint-tooltip',
                            content: 'text:"Time spent by the engine on tasks other than executing JavaScript code. This includes overheads like JIT compilation, managing execution contexts, and time in engine\'s internal code. It reflects the internal processing and environment setup necessary for running JavaScript code, rather than the execution of the code itself."'
                        }
                    },
                    {
                        view: 'checkbox',
                        name: 'showGC',
                        checked: true,
                        content: 'text:"(garbage collector)"',
                        tooltip: {
                            showDelay: true,
                            className: 'hint-tooltip',
                            content: 'text:"When the CPU profile shows time spent in the garbage collector, it indicates the time consumed in these memory management activities. Frequent or prolonged garbage collection periods might be a sign of inefficient memory use in the application, like creating too many short-lived objects or holding onto unnecessary references."'
                        }
                    }
                ]
            },
            {
                view: 'toggle',
                className: 'flamechart-fullpage-toggle',
                // checked: '=#.params.fullScreen',
                content: 'text:"Full page"',
                onToggle: toggleFullPageFlamechart
            }
        ]
    },
    content: {
        view: 'flamechart',
        tree: '=$[#.dataset]',
        lockScrolling: true
    }
};

discovery.page.define('default', {
    view: 'switch',
    content: [
        {
            when: 'no #.datasets',
            content: [
                {
                    view: 'page-header',
                    content: 'h1:"CPU (pro)file"'
                },
                {
                    view: 'markdown',
                    source: [
                        'A viewer for CPU profiles collected in Node.js or Chromium browsers.',
                        '',
                        'Supported formats:',
                        '* [V8 CPU profile](https://v8.dev/docs/profile) (.cpuprofile)',
                        '* [Chromium timeline](https://www.debugbear.com/blog/devtools-performance#recording-a-performance-profile) / [Trace Event](https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/preview) format (.json)'
                    ]
                },
                'html:"<br>"',
                'preset/upload',
                'html:"<br><br>"',
                {
                    view: 'button',
                    onClick: '=#.actions.uploadDemoData',
                    content: 'text:"Try demo CPU profile"'
                }
            ]
        },
        { content: [
            {
                view: 'page-header',
                content: [
                    {
                        view: 'h2',
                        content: [
                            { view: 'block', className: 'logo' },
                            'text:#.datasets[].resource | type = "file" ? name : "Untitled profile"'
                        ]
                    }
                ]
            },

            {
                view: 'block',
                className: 'indicators',
                content: [
                    {
                        view: 'page-indicator',
                        title: 'Total time',
                        value: '=totalTime.ms()',
                        unit: true
                    },
                    {
                        view: 'page-indicator',
                        title: 'Samples',
                        value: '=samplesCount'
                    },
                    {
                        view: 'page-indicator',
                        title: 'Sampling interval',
                        value: '=samplesInterval',
                        unit: 'μs'
                    },
                    {
                        view: 'page-indicator',
                        className: 'runtime',
                        title: 'Runtime',
                        value: '=#.data.runtime'
                    },
                    {
                        view: 'page-indicator',
                        title: 'Engine',
                        value: '=#.data.engine'
                    }
                ]
            },

            {
                view: 'timeline-profiles',
                data: 'profiles',
                whenData: true
            },

            {
                view: 'expand',
                expanded: true,
                className: 'timelines trigger-outside',
                header: areasTimeBars,
                content: areasTimeline
            },

            {
                view: 'expand',
                expanded: true,
                className: 'hierarchical-components trigger-outside',
                header: 'text:"Hierarchical components"',
                content: [
                    packagesList,
                    modulesList,
                    functionList
                ]
            },

            {
                view: 'expand',
                expanded: true,
                className: 'flamecharts trigger-outside',
                header: 'text:"Flame charts"',
                content: flamecharts
            }

            // 'text:"(debug) "',
            // 'link:{ text: "Check timings data", href: "#report&title=Check%20timings&q=JHN1bVNlbGY6ID0%2BIHJlZHVjZSg9PiQkICsgc2VsZlRpbWUsIDApOwokc3VtVG90YWw6ID0%2BIHJlZHVjZSg9PiQkICsgdG90YWxUaW1lLCAwKTsKJGNoZWNrOiA9PiB7CiAgJGV4cGVjdGVkOiAkJDsKICBzZWxmOiAkc3VtU2VsZigpID0gJGV4cGVjdGVkIGFuZCBubyAuW3NlbGZUaW1lID4gdG90YWxUaW1lXSwKICB0b3RhbDogbm90IC5bdG90YWxUaW1lID4gJGV4cGVjdGVkXQp9OwpbCiAgeyB0aXRsZTogJ25vZGVzJywgLi4ubm9kZXMuJGNoZWNrKHRvdGFsVGltZSkgfSwKICB7IHRpdGxlOiAnZnVuY3Rpb25zJywgLi4uZnVuY3Rpb25zLiRjaGVjayh0b3RhbFRpbWUpIH0sCiAgeyB0aXRsZTogJ2Z1bmN0aW9ucy5jaGlsZHJlbicsIC4uLmZ1bmN0aW9ucy5jaGlsZHJlbi4kY2hlY2sodG90YWxUaW1lKSwgbmVzdGVkVG90YWw6IG5vIGZ1bmN0aW9ucy5bY2hpbGRyZW4uJHN1bVRvdGFsKCkgIT0gdG90YWxUaW1lIC0gc2VsZlRpbWVdIH0sCiAgeyB0aXRsZTogJ21vZHVsZXMnLCAuLi5tb2R1bGVzLiRjaGVjayh0b3RhbFRpbWUpIH0sCiAgeyB0aXRsZTogJ21vZHVsZXMuY2hpbGRyZW4nLCAuLi5tb2R1bGVzLmNoaWxkcmVuLiRjaGVjayh0b3RhbFRpbWUpLCBuZXN0ZWRUb3RhbDogbm8gbW9kdWxlcy5bY2hpbGRyZW4uJHN1bVRvdGFsKCkgIT0gdG90YWxUaW1lIC0gc2VsZlRpbWVdIH0sCiAgeyB0aXRsZTogJ3BhY2thZ2VzJywgLi4ucGFja2FnZXMuJGNoZWNrKHRvdGFsVGltZSkgfSwKICB7IHRpdGxlOiAncGFja2FnZXMuY2hpbGRyZW4nLCAuLi5wYWNrYWdlcy5jaGlsZHJlbi4kY2hlY2sodG90YWxUaW1lKSwgbmVzdGVkVG90YWw6IG5vIHBhY2thZ2VzLltjaGlsZHJlbi4kc3VtVG90YWwoKSAhPSB0b3RhbFRpbWUgLSBzZWxmVGltZV0gfSwKICB7IHRpdGxlOiAnYXJlYXMnLCAuLi5hcmVhcy4kY2hlY2sodG90YWxUaW1lKSB9LAogIHsgdGl0bGU6ICdhcmVhcy5jaGlsZHJlbicsIC4uLmFyZWFzLmNoaWxkcmVuLiRjaGVjayh0b3RhbFRpbWUpLCBuZXN0ZWRUb3RhbDogbm8gYXJlYXMuW2NoaWxkcmVuLiRzdW1Ub3RhbCgpICE9IHRvdGFsVGltZSAtIHNlbGZUaW1lXSB9Cl0K&v=ewogICAgdmlldzogJ3RhYmxlJywKICAgIGNvbHM6IHsKICAgICAgc2VsZjogeyBjb250ZW50OiBbJ2NoZWNrYm94eyBjaGVja2VkOiBzZWxmIH0nXSB9LAogICAgICB0b3RhbDogeyBjb250ZW50OiBbJ2NoZWNrYm94eyBjaGVja2VkOiB0b3RhbCB9J10gfSwKICAgICAgbmVzdGVkVG90YWw6IHsgY29udGVudDogWydjaGVja2JveHsgd2hlbjogbmVzdGVkVG90YWwsIGNoZWNrZWQ6IG5lc3RlZFRvdGFsIH0nXSB9CiAgICB9Cn0%3D" }'
        ] }
    ]
});
