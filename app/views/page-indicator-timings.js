const definitions = {
    selfTime: 'The time spent executing a function\'s own code, excluding any time used by other functions it calls.',
    nestedTime: 'The time accounted for the execution of functions that are called by a given function, excluding the time taken to execute the original function\'s own code itself.',
    totalTime: 'The complete time taken to execute a function. It includes both \'self time\', which is the time the function spends executing its own code, and \'nested time\', which is the time spent executing all other functions that are called from within this function.'
};

function hint(title, slug) {
    return 'md{ source: "#### ' + title + '\\n\\' + definitions[slug] + '\\n\\nFor modules, packages, or categories, it represents the accumulated time for all functions that belong to them.\\n\\nA \\\`Filtered\\` badge indicates that the displayed time represents only a portion of the total time, due to a selected range on the timeline." }';
}

function hintPercent(title, slug) {
    return 'md{ source: "#### ' + title + ', %\\n\\nRepresents the proportion of the total duration of a profiling session.\\n\\n`100%` × `{{filtered.' + slug + ' | ms()}}` ⁄ `{{#.data.totalTime | ms()}}` = `{{filtered.' + slug + ' | totalPercent(2)}}`" }';
}

discovery.view.define('page-indicator-timings', {
    view: 'page-indicator-group',
    className: 'view-page-indicator-timings',
    content: [
        {
            title: 'Self time',
            hint: hint('Self time', 'selfTime'),
            content: [
                { view: 'text-with-unit', value: '=filtered.selfTime | ? ms() : "—"', unit: true },
                { view: 'text-with-unit', value: '=full.selfTime | ? ms() : "—"', unit: true }
            ],
            annotation: {
                view: 'badge',
                when: 'filtered.selfTime != full.selfTime',
                content: 'text:"filtered"'
            }
        },
        {
            title: 'Self time, %',
            hint: hintPercent('Self time', 'selfTime'),
            value: '=filtered.selfTime | ? totalPercent() : "—"',
            unit: true
        },
        {
            title: 'Nested time',
            hint: hint('Nested time', 'nestedTime'),
            content: [
                { view: 'text-with-unit', value: '=filtered.nestedTime | ? ms() : "—"', unit: true },
                { view: 'text-with-unit', value: '=full.nestedTime | ? ms() : "—"', unit: true }
            ],
            annotation: {
                view: 'badge',
                when: 'filtered.nestedTime != full.nestedTime',
                content: 'text:"filtered"'
            }
        },
        {
            title: 'Nested time, %',
            hint: hintPercent('Nested time', 'nestedTime'),
            value: '=filtered.nestedTime | ? totalPercent() : "—"',
            unit: true
        },
        {
            title: 'Total time',
            hint: hint('Total time', 'totalTime'),
            content: [
                { view: 'text-with-unit', value: '=filtered.totalTime | ? ms() : "—"', unit: true },
                { view: 'text-with-unit', value: '=full.totalTime | ? ms() : "—"', unit: true }
            ],
            annotation: {
                view: 'badge',
                when: 'filtered.totalTime != full.totalTime',
                content: 'text:"filtered"'
            }
        },
        {
            title: 'Total time, %',
            hint: hintPercent('Total time', 'totalTime'),
            value: '=filtered.totalTime | ? totalPercent() : "—"',
            unit: true
        }
    ]
}, { tag: false });
