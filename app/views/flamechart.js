/* eslint-env node */
const { ContentRect } = require('@discoveryjs/discovery').utils;
const { select } = require('d3-selection');
const flamechart = require('./flamechart/d3-flamechart').default;
const tooltip = require('./flamechart/tooltip').default;

let lastWidth = null;

function convertTree(node) {
    return {
        name: node.host.name || node.host.packageRelPath,
        value: node.totalTime,
        node,
        children: node.children?.map(convertTree).sort((a, b) => a.name > b.name ? 1 : a.name < b.name ? -1 : 0)
    };
}

discovery.view.define('flamechart', function(el, config, data, context) {
    const contentEl = document.createElement('div');
    const titleEl = document.createElement('div');
    const destroyEl = document.createElement('destroy-flamechart');

    contentEl.className = 'view-flamechart__content';
    titleEl.className = 'view-flamechart__title';

    contentEl.append(titleEl);
    el.append(contentEl, destroyEl);

    const sizeObserver = new ContentRect();
    sizeObserver.observe(contentEl);

    const chart = flamechart()
        .inverted(true)
        .resetHeightOnZoom(true);
        // .setColorMapper(colorMapper.offCpuColorMapper);

    chart.tooltip(tooltip(
        // discovery.dom.container,
        discovery,
        (el, data) => {
            el.innerHTML = '';
            discovery.view.render(el, [
                {
                    view: 'switch',
                    data: 'node.host',
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
                'duration{ id: "self-time", data: { time: value, total: #.data.totalTime } }'
            ], data, context);
        }
    ));

    if (lastWidth) {
        chart.width(lastWidth);
    }

    const tree = convertTree(data);
    select(contentEl)
        .datum(tree)
        .call(chart, lastWidth !== null);

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
