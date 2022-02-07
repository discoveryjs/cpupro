discovery.page.define('default', {
    view: 'switch',
    content: [
        {
            when: 'not #.dataLoaded',
            content: [
                {
                    view: 'h1',
                    content: 'text:"CPU pro"'
                },
                {
                    view: 'markdown',
                    source: 'CPU profiler viewer'
                },
                'html:"<br>"',
                {
                    view: 'button-primary',
                    onClick: '=#.actions.uploadFile',
                    content: 'text:`Open file ${#.actions.uploadFile.fileExtensions | $ ? "(" + join(", ") + ")" : ""}`'
                },
                'html:"<span style=\\"color: #888; padding: 0 1ex\\"> or </span>"',
                'text:"drop a file on the page"'
            ]
        },
        { content: [
            {
                view: 'page-header',
                content: 'h1:#.name'
            },

            'text:"Total time: " + totalTime.ms()',
            {
                view: 'timing-bar',
                data: 'areas.({ text: name, duration: selfTime, href: marker("area").href })'
            },

            {
                view: 'hstack',
                content: [
                    {
                        view: 'section',
                        when: 'packages.size() > 1',
                        header: 'text:"Packages / scopes"',
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
                        header: 'text:"Modules"',
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
                        header: 'text:"Functions"',
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
