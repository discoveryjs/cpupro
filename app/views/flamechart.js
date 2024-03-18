const { utils } = require('@discoveryjs/discovery');
const { FlameChart } = require('./flamechart/index');
const Tooltip = require('./flamechart/tooltip').default;

discovery.view.define('flamechart', function(el, config, data, context) {
    const { tree, timings, lockScrolling } = config;
    const contentEl = utils.createElement('div', 'view-flamechart__content');
    const destroyEl = utils.createElement('destroy-flamechart');
    const enableScrolling = (e) => e.which !== 3 && setTimeout(() => el.classList.remove('disable-scrolling'), 0);
    const enableScrollingEl = utils.createElement('div', {
        class: 'view-flamechart__enable-scrolling-button',
        onclick: enableScrolling
    }, 'Start interacting with the chart or click the button to enable scrolling');

    const tooltip = new Tooltip(discovery, (el, nodeIndex) => this.render(el, [
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
            data: '{ time: totalTime, total: #.data.totalTime }'
        },
        {
            view: 'duration',
            className: 'self',
            data: '{ time: selfTime, total: #.data.totalTime }'
        }
    ], tree.getEntry(nodeIndex), context));

    const chart = new FlameChart(contentEl)
        .on('frame:enter', tooltip.show)
        .on('frame:leave', tooltip.hide)
        .on('destroy', tooltip.destroy);

    chart.colorMapper = discovery.queryFn(`
        | package.type or module.package.type or type or area.name or name
        | color(true)
    `);

    const setDataStart = Date.now();
    const { selfTimes, nestedTimes } = timings;
    const setData = () => chart.setData(tree, {
        name: host => host.name || host.packageRelPath,
        value: nodeIndex => selfTimes[nodeIndex] + nestedTimes[nodeIndex]
    });

    const unsubscribeTimings = timings.on(setData);
    setData();

    console.log('Flamechart.setData()', Date.now() - setDataStart);

    contentEl.append(chart.el);
    el.append(contentEl, enableScrollingEl, destroyEl);

    if (lockScrolling) {
        el.classList.add('disable-scrolling');
    }

    const removeOnScrollListener = discovery.addHostElEventListener('scroll', ({ target }) => {
        // to avoid expensive dom checks
        if (el.classList.contains('disable-scrolling')) {
            return;
        }

        // scrolled to top & target is an ancestor and not a descendant of el
        // in other words, ignore scrolling inside the flamechart but take into account ancestors scrolling
        if (target.contains(el) && !el.contains(target) && contentEl.scrollTop === 0) {
            el.classList.add('disable-scrolling');
        }
    }, {
        capture: true,
        passive: true
    });

    let removeOnPointerDownListener = null;
    destroyEl.onConnect = () => {
        let cursor = el;

        while (cursor !== null && cursor.parentNode !== discovery.dom.pageContent) {
            cursor = cursor.parentNode;
        }

        if (cursor) {
            cursor.addEventListener('pointerdown', enableScrolling, true);
            removeOnPointerDownListener = () => cursor.removeEventListener('pointerdown', enableScrolling, true);
        }
    };
    destroyEl.onDestroy = () => {
        removeOnPointerDownListener?.();
        removeOnScrollListener();
        unsubscribeTimings();
        tooltip.destroy();
        chart.destroy();
    };
}, { tag: 'div' });

class FlameChartElement extends HTMLElement {
    connectedCallback() {
        this.onConnect();
        this.onConnect = null;
    }
    disconnectedCallback() {
        this.onDestroy();
        this.onDestroy = null;
    }
}

customElements.define('destroy-flamechart', FlameChartElement);
