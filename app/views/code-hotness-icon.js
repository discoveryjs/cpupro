import { vmFunctionStateTierHotness } from '../prepare/const.js';

const tooltipConfig = {
    className: 'view-code-hotness-icon__tooltip',
    showDelay: true,
    content: [
        'text:"Function is considered "',
        'code-hotness-icon{ tier, showLabel: true, showHint: false }',
        'html:` since its top tier is <span style="color:${tier.color()[:-2]+`d0`}">${tier}</span>`',
        { view: 'md', source: [
            'Code in the V8 engine progresses through multiple optimization tiers:',
            '- <span style="color:{{`Ignition`.color()[:-2]+`d0`}}">Ignition</span> — Bytecode interpreter (with/without feedback); code starts here when it is first executed',
            '- <span style="color:{{`Sparkplug`.color()[:-2]+`d0`}}">Sparkplug</span> — Unoptimized (baseline) machine code; code that runs repeatedly',
            '- <span style="color:{{`Maglev`.color()[:-2]+`d0`}}">Maglev</span> — Semi-optimized machine code; code that continues running frequently',
            '- <span style="color:{{`Turbofan`.color()[:-2]+`d0`}}">Turbofan</span> — Fully optimized machine code; code that runs extensively',
            '',
            'V8 promotes functions to higher tiers based on execution frequency, with possible deoptimizations if needed.'
        ].join('\n') }
    ]
};

discovery.view.define('code-hotness-icon', function(el, config, data) {
    let { tier = data, showLabel, showHint = true } = config;
    const hotness = vmFunctionStateTierHotness[tier] || 'unknown';

    if (showLabel) {
        el.dataset.label = hotness;
    }

    el.dataset.tier = tier;
    el.className = `hotness-${hotness}`;

    if (showHint) {
        this.tooltip(el, tooltipConfig, { tier, hotness });
    }
});
