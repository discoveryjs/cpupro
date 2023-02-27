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
                data: 'data.host',
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
                data: '{ time: value, total: ..parent[-2].value }'
            },
            {
                view: 'duration',
                className: 'self',
                data: '{ time: value - (next.parent = $ ? next + next..nextSibling.[] | reduce(=>$$ + value, 0) : 0), total: ..parent[-2].value }'
            }
        ], data, context);
    });

    const chart = new FlameChart(contentEl)
        .on('frame:enter', tooltip.show)
        .on('frame:leave', tooltip.hide)
        .on('destroy', tooltip.destroy);
        // .setColorMapper(colorMapper.offCpuColorMapper);

    if (data.segment) {
        const children = data.children;
        const offsetScale = 1 / (data.segment[1] - data.segment[0]);

        chart.setData({
            host: data.host,
            segment: [data.segment[0], children[children.length - 1].segment[1]],
            children
        }, {
            name: frameData => frameData.host.name || frameData.host.packageRelPath,
            value: frameData => frameData.segment[1] - frameData.segment[0],
            offset: frameData => offsetScale * frameData.segment[0],
            children: frameData => frameData.children
        });
    } else {
        chart.setData(data, {
            name: frameData => frameData.host.name || frameData.host.packageRelPath,
            value: frameData => frameData.totalTime,
            children: frameData => frameData.children,
            childrenSort: true
        });
    }

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
