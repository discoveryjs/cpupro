/* eslint-env node */
const { ContentRect } = require('@discoveryjs/discovery').utils;
const flamechart = require('./flamechart/d3-flamechart').default;
const tooltip = require('./flamechart/tooltip').default;

let lastWidth = null;

discovery.view.define('flamechart', function(el, config, data, context) {
    const contentEl = document.createElement('div');
    const destroyEl = document.createElement('destroy-flamechart');

    contentEl.className = 'view-flamechart__content';

    el.append(contentEl, destroyEl);

    const sizeObserver = new ContentRect();
    sizeObserver.observe(contentEl);

    const chart = flamechart()(contentEl, lastWidth !== null)
        .inverted(true)
        .resetHeightOnZoom(true)
        .getName(framedata =>
            framedata.host.name || framedata.host.packageRelPath
        )
        .sort(true)
        .getChildren(frameData => frameData.children);
        // .setColorMapper(colorMapper.offCpuColorMapper);

    chart.tooltip(tooltip(
        discovery,
        (el, data) => {
            el.innerHTML = '';
            discovery.view.render(el, [
                {
                    view: 'switch',
                    data: 'host',
                    content: [
                        { when: 'marker("package")', content: [
                            'package-badge'
                        ] },
                        { when: 'marker("module")', content: [
                            'module-badge'
                        ] },
                        { when: 'marker("function")', content: [
                            'module-badge:module',
                            { view: 'block', content: 'text:name' }
                        ] },
                        { content: [
                            { view: 'block', content: 'text:name' }
                        ] }
                    ]
                },
                'duration{ id: "self-time", data: { time: host.totalTime, total: #.data.totalTime } }'
            ], data, context);
        }
    ));

    if (lastWidth) {
        chart.width(lastWidth);
    }

    chart.setData(data);

    const unsubscribeResize = sizeObserver.subscribe(({ width }) => {
        const newWidth = width + 1;

        if (lastWidth !== newWidth) {
            chart.width(lastWidth = newWidth).render();
        }
    });
    destroyEl.onDestroy = () => {
        unsubscribeResize();
        chart.destroy();
    };
}, { tag: 'div' });

class FlameChart extends HTMLElement {
    disconnectedCallback() {
        this.onDestroy();
        this.onDestroy = null;
    }
}

customElements.define('destroy-flamechart', FlameChart);
