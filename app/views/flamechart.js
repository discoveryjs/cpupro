const { utils } = require('@discoveryjs/discovery');
const { FlameChart } = require('./flamechart/index');
const Tooltip = require('./flamechart/tooltip').default;

function findFirstPageContentChild(el) {
    let cursor = el;

    while (cursor !== null && cursor.parentNode !== discovery.dom.pageContent) {
        cursor = cursor.parentNode;
    }

    return cursor;
}

const defaultTooltipContent = [
    {
        view: 'switch',
        data: 'node.value',
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
];

const defaultDetailsContent = [
    {
        view: 'block',
        content: {
            view: 'switch',
            data: 'value or node.value',
            content: [
                { when: 'marker("package")', content: [
                    'package-badge'
                ] },
                { when: 'marker("module")', content: [
                    'module-badge'
                ] },
                { when: 'marker("function")', content: [
                    'module-badge:module',
                    { view: 'block', content: 'link:{ text: name, href: marker("function").href }' }
                ] },
                { content: [
                    'badge:{ text: name, href: marker("category").href }'
                ] }
            ]
        }
    },
    {
        view: 'block',
        content: [
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
        ]
    }
];

discovery.view.define('flamechart', function(el, config, data, context) {
    const {
        tree,
        timings,
        lockScrolling,
        tooltipContent = defaultTooltipContent,
        detailsContent = defaultDetailsContent
    } = config;
    const contentEl = utils.createElement('div', 'view-flamechart__content');
    const destroyEl = utils.createElement('destroy-flamechart');
    const enableScrolling = (e) => {
        if (e.which !== 3 && el.classList.contains('fully-visible')) {
            setTimeout(() => el.classList.remove('disable-scrolling'), 0);
        }
    };
    const enableScrollingEl = utils.createElement('div', {
        class: 'view-flamechart__enable-scrolling-button',
        onclick: enableScrolling
    }, 'Start interacting with the chart or click the button to enable scrolling');

    const tooltip = new Tooltip(discovery, (el, nodeIndex) =>
        this.render(el, tooltipContent, timings.getTimings(nodeIndex), context)
    );

    let detailsNodeIndex = -1;
    let selectedNodeIndex = -1;
    let zoomedNodeIndex = -1;
    const detailsEl = utils.createElement('div', 'view-flamechart__details', 'test');
    const renderDetails = (force) => {
        const nextDetailsNodeIndex = selectedNodeIndex !== -1
            ? selectedNodeIndex
            : zoomedNodeIndex > 0
                ? zoomedNodeIndex
                : -1;

        if (nextDetailsNodeIndex !== detailsNodeIndex || force) {
            detailsNodeIndex = nextDetailsNodeIndex;

            if (detailsNodeIndex >= 0) {
                detailsEl.classList.add('has-details');
                detailsEl.innerHTML = '';

                this.render(
                    detailsEl,
                    detailsContent,
                    selectedNodeIndex !== -1
                        ? timings.getValueTimings(tree.nodes[detailsNodeIndex])
                        : timings.getTimings(detailsNodeIndex),
                    context
                );
            } else {
                detailsEl.classList.remove('has-details');
            }
        }
    };

    const chart = new FlameChart(contentEl)
        .on('select', (nodeIndex) => {
            selectedNodeIndex = nodeIndex;
            renderDetails();
        })
        .on('zoom', (nodeIndex) => {
            zoomedNodeIndex = nodeIndex;
            renderDetails();
        })
        .on('frame:enter', tooltip.show)
        .on('frame:leave', tooltip.hide)
        .on('destroy', tooltip.destroy);

    chart.colorMapper = discovery.queryFn(`
        | package.type or type or category.name or name
        | color(true)
    `);

    const setDataStart = Date.now();
    const { selfTimes, nestedTimes } = timings;
    const unsubscribeTimings = timings.on(utils.debounce(() => {
        chart.resetValues();
        renderDetails(true);

        if (lockScrolling) {
            el.classList.add('disable-scrolling');
        }
    }, 16, { maxWait: 48 }));

    chart.setData(tree, {
        name: value => value.name || value.packageRelPath,
        value: nodeIndex => selfTimes[nodeIndex] + nestedTimes[nodeIndex],
        childrenSort: true
    });

    console.log('Flamechart.setData()', Date.now() - setDataStart);

    renderDetails();
    contentEl.append(chart.el);
    el.append(contentEl, detailsEl, enableScrollingEl, destroyEl);

    if (lockScrolling) {
        el.classList.add('lock-scrolling', 'disable-scrolling');
    }

    const removeOnScrollListener = discovery.addHostElEventListener('scroll', ({ target }) => {
        // to avoid expensive dom checks
        if (el.classList.contains('disable-scrolling')) {
            return;
        }

        // scrolled to top & target is an ancestor and not a descendant of el
        // in other words, ignore scrolling inside the flamechart but take into account ancestors scrolling
        if (target.contains(el) && !el.contains(target)) {
            el.classList.add('disable-scrolling');
        }
    }, {
        capture: true,
        passive: true
    });

    let removeOnPointerDownListener = null;
    let intersectionObserver = null;
    let detailsResizeObserver = null;
    destroyEl.onConnect = () => {
        const firstPageContentChild = findFirstPageContentChild(el);

        if (firstPageContentChild) {
            firstPageContentChild.addEventListener('pointerdown', enableScrolling, true);
            removeOnPointerDownListener = () => firstPageContentChild.removeEventListener('pointerdown', enableScrolling, true);
        }

        intersectionObserver = new IntersectionObserver(function(entries) {
            for (const entry of entries) {
                el.classList.toggle('fully-visible', entry.intersectionRatio === 1);
            }
        }, {
            root: document.body,
            threshold: [0, .999, 1.0]
        });
        intersectionObserver.observe(el);

        detailsResizeObserver = new ResizeObserver(function(entries) {
            for (const entry of entries) {
                el.style.setProperty('--details-height', `${entry.borderBoxSize[0].blockSize}px`);
            }
        });
        detailsResizeObserver.observe(detailsEl);
    };
    destroyEl.onDestroy = () => {
        removeOnPointerDownListener?.();
        removeOnScrollListener();
        unsubscribeTimings();
        intersectionObserver.disconnect();
        intersectionObserver = null;
        detailsResizeObserver.disconnect();
        detailsResizeObserver = null;
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
