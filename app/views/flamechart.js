/* eslint-env node */
const { FlameChart } = require('./flamechart/index');
const Tooltip = require('./flamechart/tooltip').default;

discovery.view.define('flamechart', function(el, config, data, context) {
    const contentEl = document.createElement('div');
    const destroyEl = document.createElement('destroy-flamechart');

    contentEl.className = 'view-flamechart__content';

    const tooltip = new Tooltip(discovery, (el, data) => {
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
            {
                view: 'duration',
                className: 'total',
                data: '{ time: host.totalTime, total: #.data.totalTime }'
            },
            {
                view: 'duration',
                className: 'self',
                data: '{ time: host.selfTime, total: #.data.totalTime }'
            }
        ], data, context);
    });

    const chart = new FlameChart(contentEl)
        .on('frame:enter', tooltip.show)
        .on('frame:leave', tooltip.hide)
        .on('destroy', tooltip.destroy);
        // .setColorMapper(colorMapper.offCpuColorMapper);

    chart.setData(data, {
        name: frameData => frameData.host.name || frameData.host.packageRelPath,
        value: frameData => frameData.totalTime,
        children: frameData => frameData.children,
        childrenSort: true
    });

    contentEl.append(chart.el);
    el.append(contentEl, destroyEl);

    destroyEl.onDestroy = () => {
        tooltip.destroy();
        chart.destroy();
    };
}, { tag: 'div' });

class FlameChartElement extends HTMLElement {
    disconnectedCallback() {
        this.onDestroy();
        this.onDestroy = null;
    }
}

customElements.define('destroy-flamechart', FlameChartElement);
