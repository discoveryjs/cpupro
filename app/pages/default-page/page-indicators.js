// input: scopeProfile
export const pageIndicators = {
    view: 'page-indicators',
    content: [
        {
            className: '=`runtime ${runtime.code}`',
            title: 'Runtime',
            hint: markdown(
                '#### Runtime',
                'The runtime is heuristically determined based on modules identified within the profile.'
            ),
            value: '=runtime | code != "unknown" ? name : `Unknown/${engine}`'
        },
        {
            view: 'page-indicator-group',
            content: [
                {
                    title: '="axis".metricName()',
                    hint: markdownMetric('axis'),
                    value: '=scopeLine().axisTotal.formatValue()',
                    unit: true
                },
                {
                    title: 'Samples',
                    hint: markdown(
                        '#### Samples',
                        'The total number of samples captured during the profiling session.',
                        'Each sample represents the CPU\'s state, including the call stack, at a specific time interval, revealing which functions are executing at each point.',
                        'For efficiency, CPUpro merges sequentially identical samples, reducing the workload of processing samples.',
                        '- Captured samples: `{{scopeLine().sourceInfo.samples}}`',
                        '- Deduplicated samples: `{{scopeLine().samples.size()}}`'
                    ),
                    value: '=scopeLine().sourceInfo.samples'
                },
                {
                    title: 'Sampling interval',
                    hint: markdownMetric('samplingInterval'),
                    value: '=scopeLine().sourceInfo.samplesInterval',
                    unit: '=scopeLine().kind = "memory" ? "b" : "μs"'
                }
            ]
        },
        {
            view: 'page-indicator-group',
            content: [
                {
                    title: 'Call tree nodes',
                    hint: 'md:"#### Call tree nodes\\n\\nA **call tree** is a data structure that represents the hierarchy of function calls during the execution of a program. It demostrates the actual sequences of function calls that occurred during the profiling session.\\n\\nThe metric indicates **the size of the tree** (the number of leafs). Typically, the number of distinct functions is less than the call tree\'s size, reflecting multiple calls to the same functions from various parts of the program."',
                    value: '=callFramesTree.nodes.size()'
                },
                {
                    title: 'Call frames',
                    hint: 'md:"#### Call frames\\n\\nThe count of unique functions encountered during profiling. This metric helps identify the diversity of function executions regardless of their position in the call stacks.\\n\\nUniqueness is determined by attributes such as `scriptId`, `function name`, `url`, `line number`, and `column number`."',
                    value: '=callFrames.size()'
                }
            ]
        },
        {
            view: 'page-indicator-group',
            className: 'filters',
            content: {
                view: 'update-on-line-metrics-changes',
                metrics: '=scopeLine().samplesMetricsFiltered',
                content: {
                    view: 'context',
                    when: 'scopeLine().samplesMetricsFiltered.rangeStart != null',
                    content: [
                        {
                            view: 'block',
                            className: 'page-indicator-group-tag'
                        },
                        {
                            view: 'page-indicator',
                            title: 'Samples',
                            value: '=scopeLine().samplesMetricsFiltered.rangeSamples'
                        },
                        {
                            view: 'page-indicator',
                            title: 'Range',
                            value: '=`${scopeLine().samplesMetricsFiltered.rangeStart.formatMicrosecondsTime()} – ${scopeLine().samplesMetricsFiltered.rangeEnd.formatMicrosecondsTime()}`'
                        }
                    ]
                }
            }
        }
    ]
};

function markdown(...lines) {
    return {
        view: 'markdown',
        source: lines.join('\n\n')
    };
}

function markdownMetric(metric) {
    return {
        view: 'markdown',
        source: '=`#### ${"' + metric + '".metricName()}\\n\\n${"' + metric + '".metricDefinition()}`'
    };
}
