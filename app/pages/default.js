discovery.page.define('default', {
    view: 'switch',
    content: [
        {
            when: 'not #.dataLoaded',
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
                'preset/upload'
            ]
        },
        { content: [
            {
                view: 'page-header',
                content: 'h1:#.name'
            },

            'text-numeric:"Total time: " + totalTime.ms()',
            {
                view: 'timing-bar',
                data: `areas.({
                    text: name,
                    duration: selfTime,
                    href: marker("area").href
                })`
            },

            {
                view: 'expand',
                expanded: true,
                className: 'flamecharts',
                header: 'text:"Flame charts"',
                content: {
                    view: 'context',
                    modifiers: {
                        view: 'block',
                        className: 'toolbar',
                        content: [
                            {
                                view: 'toggle-group',
                                name: 'dataset',
                                data: [
                                    { text: 'Areas', value: 'areaTree' },
                                    { text: 'Packages', value: 'packageTree', active: true },
                                    { text: 'Modules', value: 'moduleTree' },
                                    { text: 'Functions', value: 'functionTree' }
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
                                        content: 'text:"(idle)"'
                                    },
                                    {
                                        view: 'checkbox',
                                        name: 'showProgram',
                                        checked: true,
                                        content: 'text:"(program)"'
                                    },
                                    {
                                        view: 'checkbox',
                                        name: 'showGC',
                                        checked: true,
                                        content: 'text:"(garbage collector)"'
                                    }
                                ]
                            },
                            {
                                view: 'toggle',
                                className: 'flamechart-fullpage-toggle',
                                // checked: '=#.params.fullScreen',
                                content: 'text:"Full page"',
                                onToggle() {
                                    // const params = { ...discovery.pageParams };

                                    // if (enabled) {
                                    //     params.fullScreen = true;
                                    // } else {
                                    //     delete params.fullScreen;
                                    // }

                                    // discovery.setPageParams(params);
                                    // discovery.cancelScheduledRender();
                                    discovery.dom.root.querySelector('.page').classList.toggle('flamecharts-fullpage');
                                    discovery.dom.root.querySelector('.flamechart-fullpage-toggle').classList.toggle('checked');
                                }
                            }
                        ]
                    },
                    content: `flamechart:
                        $root: $[#.dataset];
                        $children: $root.children.[host | (#.showIdle or name != "(idle)") and (#.showProgram or name != "(program)") and (#.showGC or name != "(garbage collector)")];
                        { ...$root, $children, totalTime: $children.sum(=>totalTime) }
                    `
                }
            },

            {
                view: 'hstack',
                content: [
                    {
                        view: 'section',
                        when: 'packages.size() > 1',
                        header: [
                            'text:"Packages / scopes "',
                            'badge:packages.size()'
                        ],
                        content: {
                            view: 'table',
                            data: 'packages.sort(selfTime desc, totalTime desc)',
                            limit: 15,
                            cols: [
                                { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                                { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                                { header: 'Package', sorting: 'name asc', content: 'package-badge' }
                            ]
                        }
                    },
                    {
                        view: 'section',
                        header: [
                            'text:"Modules "',
                            'badge:modules.size()'
                        ],
                        content: {
                            view: 'table',
                            data: 'modules.sort(selfTime desc, totalTime desc)',
                            limit: 15,
                            cols: [
                                { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                                { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                                { header: 'Module', sorting: '(name or path) ascN', content: 'module-badge' }
                            ]
                        }
                    },
                    {
                        view: 'section',
                        header: [
                            'text:"Functions "',
                            'badge:functions.size()'
                        ],
                        content: {
                            view: 'table',
                            data: 'functions.sort(selfTime desc, totalTime desc)',
                            limit: 15,
                            cols: [
                                { header: 'Self time', sorting: 'selfTime desc, totalTime desc', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                                { header: 'Total time', sorting: 'totalTime desc, selfTime desc', content: 'duration:{ time: totalTime, total: #.data.totalTime }' },
                                { header: 'Function', sorting: 'name ascN', content: 'auto-link' }
                            ]
                        }
                    }
                ]
            },

            'text:"(debug) "',
            'link:{ text: "Check timings data", href: "#report&title=Check%20timings&q=JHN1bVNlbGY6ID0%2BIHJlZHVjZSg9PiQkICsgc2VsZlRpbWUsIDApOwokc3VtVG90YWw6ID0%2BIHJlZHVjZSg9PiQkICsgdG90YWxUaW1lLCAwKTsKJGNoZWNrOiA9PiB7CiAgJGV4cGVjdGVkOiAkJDsKICBzZWxmOiAkc3VtU2VsZigpID0gJGV4cGVjdGVkIGFuZCBubyAuW3NlbGZUaW1lID4gdG90YWxUaW1lXSwKICB0b3RhbDogbm90IC5bdG90YWxUaW1lID4gJGV4cGVjdGVkXQp9OwpbCiAgeyB0aXRsZTogJ25vZGVzJywgLi4ubm9kZXMuJGNoZWNrKHRvdGFsVGltZSkgfSwKICB7IHRpdGxlOiAnZnVuY3Rpb25zJywgLi4uZnVuY3Rpb25zLiRjaGVjayh0b3RhbFRpbWUpIH0sCiAgeyB0aXRsZTogJ2Z1bmN0aW9ucy5jaGlsZHJlbicsIC4uLmZ1bmN0aW9ucy5jaGlsZHJlbi4kY2hlY2sodG90YWxUaW1lKSwgbmVzdGVkVG90YWw6IG5vIGZ1bmN0aW9ucy5bY2hpbGRyZW4uJHN1bVRvdGFsKCkgIT0gdG90YWxUaW1lIC0gc2VsZlRpbWVdIH0sCiAgeyB0aXRsZTogJ21vZHVsZXMnLCAuLi5tb2R1bGVzLiRjaGVjayh0b3RhbFRpbWUpIH0sCiAgeyB0aXRsZTogJ21vZHVsZXMuY2hpbGRyZW4nLCAuLi5tb2R1bGVzLmNoaWxkcmVuLiRjaGVjayh0b3RhbFRpbWUpLCBuZXN0ZWRUb3RhbDogbm8gbW9kdWxlcy5bY2hpbGRyZW4uJHN1bVRvdGFsKCkgIT0gdG90YWxUaW1lIC0gc2VsZlRpbWVdIH0sCiAgeyB0aXRsZTogJ3BhY2thZ2VzJywgLi4ucGFja2FnZXMuJGNoZWNrKHRvdGFsVGltZSkgfSwKICB7IHRpdGxlOiAncGFja2FnZXMuY2hpbGRyZW4nLCAuLi5wYWNrYWdlcy5jaGlsZHJlbi4kY2hlY2sodG90YWxUaW1lKSwgbmVzdGVkVG90YWw6IG5vIHBhY2thZ2VzLltjaGlsZHJlbi4kc3VtVG90YWwoKSAhPSB0b3RhbFRpbWUgLSBzZWxmVGltZV0gfSwKICB7IHRpdGxlOiAnYXJlYXMnLCAuLi5hcmVhcy4kY2hlY2sodG90YWxUaW1lKSB9LAogIHsgdGl0bGU6ICdhcmVhcy5jaGlsZHJlbicsIC4uLmFyZWFzLmNoaWxkcmVuLiRjaGVjayh0b3RhbFRpbWUpLCBuZXN0ZWRUb3RhbDogbm8gYXJlYXMuW2NoaWxkcmVuLiRzdW1Ub3RhbCgpICE9IHRvdGFsVGltZSAtIHNlbGZUaW1lXSB9Cl0K&v=ewogICAgdmlldzogJ3RhYmxlJywKICAgIGNvbHM6IHsKICAgICAgc2VsZjogeyBjb250ZW50OiBbJ2NoZWNrYm94eyBjaGVja2VkOiBzZWxmIH0nXSB9LAogICAgICB0b3RhbDogeyBjb250ZW50OiBbJ2NoZWNrYm94eyBjaGVja2VkOiB0b3RhbCB9J10gfSwKICAgICAgbmVzdGVkVG90YWw6IHsgY29udGVudDogWydjaGVja2JveHsgd2hlbjogbmVzdGVkVG90YWwsIGNoZWNrZWQ6IG5lc3RlZFRvdGFsIH0nXSB9CiAgICB9Cn0%3D" }'
        ] }
    ]
});
