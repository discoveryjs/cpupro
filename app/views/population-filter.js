import { sum } from '../prepare/misc/utils.js';
import { populationFilter } from './population-filter.config.js';

const selectedCount = 'options.[#.attributeFilter.filterOptionEnabled(key)].size()';
const filterPopup = new discovery.view.Popup({
    className: 'population-filter-popup',
    contentPadding: false,
    positionMode: 'natural'
});

function closeFiltersOnEscape(event) {
    if (event.key === 'Escape' && filterPopup.visible) {
        const trigger = filterPopup.lastTriggerEl;

        filterPopup.hide();
        trigger?.focus({ preventScroll: true });
        event.stopPropagation();
    }
}

filterPopup.el.setAttribute('role', 'dialog');
filterPopup.el.setAttribute('aria-label', 'Filters');
filterPopup.el.addEventListener('keydown', closeFiltersOnEscape);

discovery.view.define('population-filter-button', function(el, config, data, context) {
    return this.render(el, {
        view: 'button',
        className: 'appbar__filters',
        content: [
            'text:"Filters"',
            {
                view: 'update-on-line-metrics-changes',
                metrics: '=scopeLine().filters',
                content: {
                    view: 'text-numeric',
                    data: 'scopeLine().filters.attributeFilters().[filterActive()].size()',
                    className: '=$ ? "appbar__filter-count active" : "appbar__filter-count"',
                    text: '=$ or "none"'
                }
            }
        ],
        onClick: button => filterPopup.toggle(button, popupEl => this.render(popupEl, populationFilter, data, context)),
        postRender(button) {
            button.setAttribute('aria-haspopup', 'dialog');
            button.addEventListener('keydown', closeFiltersOnEscape);
        }
    }, data, context);
}, { tag: false });

discovery.view.define('population-filter-group-header', {
    view: 'context',
    content: [
        { view: 'block', className: 'population-filter__label', content: 'text:filter.label' },
        {
            view: 'update-on-line-metrics-changes',
            metrics: '=#.filterBreakdown.line.filters',
            content: {
                view: 'text-numeric',
                className: '=filter.filterActive() ? "population-filter__selected active" : "population-filter__selected"',
                text: `=\`\${${selectedCount}} / \${options.size()}\``
            }
        }
    ]
}, { tag: false });

discovery.view.define('population-filter-option', async function(el, config, data, context) {
    el.classList.add('view-list-item');
    el.dataset.key = data.key;

    if (data.color) {
        el.style.setProperty('--option-color', data.color);
        el.classList.add('has-color');
    }

    await this.render(el, config.content, data, context);
    el.querySelector('.population-filter__only').setAttribute('aria-label', `Select only ${data.label}`);
});

discovery.view.define('population-filter-options', function(el, config, data, context) {
    const { filter, options, optionTotals } = data;
    const included = sum(context.filterBreakdown.populationViewport.samplesTotal);
    const totals = optionTotals(filter);
    const search = (context.search || '').toLowerCase();
    const visibleOptions = options
        .filter(option => option.label.toLowerCase().includes(search))
        .map(option => {
            const total = totals.get(option.key) || 0;

            return {
                ...option,
                total,
                percent: `${(included > 0 ? total / included * 100 : 0).toFixed(1)}%`
            };
        });

    return this.render(el, [data.group, {
        view: 'block',
        className: 'population-filter__empty',
        when: 'options.size() = 0',
        content: 'text:"No matches"'
    }], { filter, options: visibleOptions }, context);
}, { tag: false });

discovery.view.define('population-filter-group', function(el, config, data, context) {
    const { filter, resetAttribute } = data;

    return this.render(el, {
        view: 'expand',
        className: 'population-filter__attribute',
        expanded: '=expanded',
        header: 'population-filter-group-header',
        content: [
            {
                view: 'update-on-line-metrics-changes',
                metrics: '=#.filterBreakdown.line.filters',
                content: {
                    view: 'block',
                    className: 'population-filter__tools',
                    content: [
                        this.composeConfig(resetAttribute, {
                            className: 'population-filter__all',
                            data: 'filter',
                            disabled: '=not filterActive()',
                            postRender: button => button.setAttribute('aria-label', `Select all ${filter.label.toLowerCase()}`)
                        }),
                        {
                            view: 'button',
                            className: 'population-filter__none',
                            text: 'None',
                            disabled: `=${selectedCount} = 0`,
                            onClick: '=$filter: filter; => $filter.setFilterSelection("include", [])',
                            postRender: button => button.setAttribute('aria-label', `Deselect all ${filter.label.toLowerCase()}`)
                        }
                    ]
                }
            },
            {
                view: 'context',
                modifiers: {
                    view: 'input',
                    className: 'population-filter__search',
                    when: 'options.size() > 10',
                    name: 'search',
                    htmlType: 'search',
                    placeholder: 'Search values',
                    value: '=search',
                    postRender: input => input.querySelector('input').setAttribute('aria-label', `Search ${filter.label.toLowerCase()}`)
                },
                onChange({ search }) {
                    data.search = search;
                },
                content: {
                    view: 'update-on-line-metrics-changes',
                    metrics: '=[#.filterBreakdown.line.filters, #.filterBreakdown.populationViewport]',
                    preserveFocus: true,
                    content: 'population-filter-options'
                }
            }
        ],
        onToggle(expanded, { el: groupEl }) {
            groupEl.querySelector('.header').setAttribute('aria-expanded', expanded);
        },
        postRender(groupEl) {
            groupEl.dataset.filter = filter.key;
            const header = groupEl.querySelector('.header');

            header.tabIndex = 0;
            header.setAttribute('role', 'button');
            header.setAttribute('aria-expanded', data.expanded);
            header.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    header.click();
                }
            });
        }
    }, data, { ...context, attributeFilter: filter });
}, { tag: false });

discovery.view.define('population-filter', function(el, config, data, context) {
    const { filters, options, optionTotals, group, resetAttribute, onReset, summary } = config;
    const groups = filters
        .map(filter => ({ filter, options: options(filter), optionTotals, group, resetAttribute, search: '' }))
        .filter(group => group.options.length > 0);

    el.setAttribute('aria-label', 'Filters');

    return this.render(el, [
        {
            view: 'block',
            className: 'population-filter__attributes',
            content: groups.map((group, index) => ({
                view: 'population-filter-group',
                data: () => ({ ...group, expanded: index === 0 })
            }))
        },
        {
            view: 'block',
            className: 'population-filter__footer',
            content: summary
        }
    ], data, { ...context, filterBreakdown: data, resetPopulationFilter: onReset });
});
