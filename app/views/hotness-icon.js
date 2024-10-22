const hotnessValues = ['cold', 'warm', 'hot'];
const tooltipConfig = {
    className: 'view-hotness-icon__tooltip',
    showDelay: true,
    content: [
        'text:"Function is considered "',
        'hotness-icon{ hotness, showLabel: true }',
        'html:` since its top tier is <span style="color:${topTier.color()[:-2]+`d0`}">${topTier}</span>`',
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

discovery.view.define('hotness-icon', function(el, config, data) {
    let { hotness = data, topTier = 'Unknown', showLabel } = config;

    if (!hotnessValues.includes(hotness)) {
        hotness = 'unknown';
    }

    if (showLabel) {
        el.dataset.label = hotness;
    }

    el.className = `hotness-${hotness}`;
    this.tooltip(el, tooltipConfig, { hotness, topTier });
});
