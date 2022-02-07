discovery.page.define('function', {
    view: 'context',
    data: 'functions[=>id = +#.id]',
    content: [
        {
            view: 'page-header',
            prelude: [
                'badge:{ color: "rgba(237, 177, 9, 0.35)", text: "Function" }',
                'module-badge'
            ],
            content: [
                'h1:name',
                'package-badge{ when: package.type = "npm" }',
                {
                    view: 'text',
                    when: 'loc',
                    data: 'loc'
                }
            ]
        },

        'text:"Self time: " + selfTime.ms()',
        'html:"<br>"',
        'text:"Total time: " + totalTime.ms()',

        'timeline-segments:calls.segments',

        {
            view: 'tree',
            data: 'calls',
            item: [
                {
                    view: 'switch',
                    content: [
                        { when: '(function.id or to.id or id) = +#.id', content: 'text:function or $ | name' },
                        { content: 'auto-link:function or to or $' }
                    ]
                },
                'text:` ${selfTime.duration()} / ${totalTime.duration()} `',
                'module-badge'
            ]
        }
    ]
});
