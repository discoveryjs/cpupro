// fork of https://github.com/spiermar/d3-flame-graph

import { select } from 'd3-selection';
import { format } from 'd3-format';
import { ascending } from 'd3-array';
import { partition, hierarchy } from 'd3-hierarchy';
import { scaleLinear } from 'd3-scale';
import { easeCubic } from 'd3-ease';
import 'd3-transition';
import { generateColorVector } from './colorUtils';
import { calculateColor } from './colorScheme';

export default function() {
    let chartWidth = 960; // graph width
    let chartHeight = null; // graph height
    let cellHeight = 18; // cell height
    let selection = null; // selection
    let tooltip = null; // tooltip
    let transitionDuration = 750;
    let transitionEase = easeCubic; // tooltip offset
    let sort = false;
    let inverted = false; // invert the graph direction
    let clickHandler = null;
    let zoomHandler = null;
    let hoverHandler = null;
    let minFrameSize = 0;
    let detailsElement = null;
    let searchDetails = null;
    let selfValue = false;
    let resetHeightOnZoom = false;
    let scrollOnZoom = false;
    let computeDelta = false;
    let colorHue = null;
    let selected = null;

    let getName = function(d) {
        return d.data.n || d.data.name;
    };

    let getValue = function(d) {
        if ('v' in d) {
            return d.v;
        } else {
            return d.value;
        }
    };

    let getChildren = function(d) {
        return d.c || d.children;
    };

    let getLibtype = function(d) {
        return d.data.l || d.data.libtype;
    };

    let getDelta = function(d) {
        if ('d' in d.data) {
            return d.data.d;
        } else {
            return d.data.delta;
        }
    };

    let searchHandler = function(searchResults, searchSum, totalValue) {
        searchDetails = () => {
            if (detailsElement) {
                detailsElement.textContent = 'search: ' + searchSum + ' of ' + totalValue + ' total samples ( ' + format('.3f')(100 * (searchSum / totalValue), 3) + '%)';
            }
        };
        searchDetails();
    };
    const originalSearchHandler = searchHandler;

    let searchMatch = (d, term, ignoreCase = false) => {
        if (!term) {
            return false;
        }
        let label = getName(d);
        if (ignoreCase) {
            term = term.toLowerCase();
            label = label.toLowerCase();
        }
        const re = new RegExp(term);
        return typeof label !== 'undefined' && label && label.match(re);
    };
    const originalSearchMatch = searchMatch;

    let detailsHandler = function(d) {
        if (detailsElement) {
            if (d) {
                detailsElement.textContent = d;
            } else {
                if (typeof searchDetails === 'function') {
                    searchDetails();
                } else {
                    detailsElement.textContent = '';
                }
            }
        }
    };
    const originalDetailsHandler = detailsHandler;

    let labelHandler = function(d) {
        return getName(d) + ' (' + format('.3f')(100 * (d.x1 - d.x0), 3) + '%, ' + getValue(d) + ' samples)';
    };

    let colorMapper = function(d) {
        return d.highlight ? '#E600E6' : colorHash(getName(d), getLibtype(d));
    };
    const originalColorMapper = colorMapper;

    function colorHash(name, libtype) {
        // Return a color for the given name and library type. The library type
        // selects the hue, and the name is hashed to a color in that hue.

        // default when libtype is not in use
        let hue = colorHue || 'warm';

        if (!colorHue && !(typeof libtype === 'undefined' || libtype === '')) {
            // Select hue. Order is important.
            hue = 'red';
            if (typeof name !== 'undefined' && name && name.match(/::/)) {
                hue = 'yellow';
            }
            if (libtype === 'kernel') {
                hue = 'orange';
            } else if (libtype === 'jit') {
                hue = 'green';
            } else if (libtype === 'inlined') {
                hue = 'aqua';
            }
        }

        const vector = generateColorVector(name);
        return calculateColor(hue, vector);
    }

    function show(d) {
        d.data.fade = false;
        d.data.hide = false;

        if (d.children) {
            d.children.forEach(show);
        }
    }

    function hideSiblings(node) {
        let child = node;
        let parent = child.parent;
        let children;

        while (parent) {
            children = parent.children;

            for (let sibling of children) {
                if (sibling !== child) {
                    sibling.data.hide = true;
                }
            }

            child = parent;
            parent = child.parent;
        }
    }

    function fadeAncestors(d) {
        if (d.parent) {
            d.parent.data.fade = true;
            fadeAncestors(d.parent);
        }
    }

    function zoom(d) {
        hideSiblings(d);
        show(d);
        fadeAncestors(d);
        update();

        if (scrollOnZoom) {
            const chartOffset = select(this).select('svg')._groups[0][0].parentNode.offsetTop;
            const maxFrames = (window.innerHeight - chartOffset) / cellHeight;
            const frameOffset = (d.height - maxFrames + 10) * cellHeight;

            window.scrollTo({
                top: chartOffset + frameOffset,
                left: 0,
                behavior: 'smooth'
            });
        }

        if (typeof zoomHandler === 'function') {
            zoomHandler(d);
        }
    }

    function searchTree(d, term) {
        const results = [];
        let sum = 0;

        function searchInner(d, foundParent) {
            let found = false;

            if (searchMatch(d, term)) {
                d.highlight = true;
                found = true;
                if (!foundParent) {
                    sum += getValue(d);
                }
                results.push(d);
            } else {
                d.highlight = false;
            }

            if (getChildren(d)) {
                getChildren(d).forEach(function(child) {
                    searchInner(child, (foundParent || found));
                });
            }
        }
        searchInner(d, false);

        return [results, sum];
    }

    function findTree(d, id) {
        if (d.id === id) {
            return d;
        } else {
            const children = getChildren(d);
            if (children) {
                for (let i = 0; i < children.length; i++) {
                    const found = findTree(children[i], id);
                    if (found) {
                        return found;
                    }
                }
            }
        }
    }

    function clear(d) {
        d.highlight = false;
        if (getChildren(d)) {
            getChildren(d).forEach(function(child) {
                clear(child);
            });
        }
    }

    function doSort(a, b) {
        if (typeof sort === 'function') {
            return sort(a, b);
        } else if (sort) {
            return ascending(getName(a), getName(b));
        }
    }

    const p = partition();

    function filterNodes(root) {
        let nodeList = root.descendants();
        if (minFrameSize > 0) {
            const kx = chartWidth / (root.x1 - root.x0);
            nodeList = nodeList.filter(function(el) {
                return ((el.x1 - el.x0) * kx) > minFrameSize;
            });
        }
        return nodeList;
    }

    function update(useTransitions = true) {
        const updateTransitionDuration = useTransitions ? transitionDuration : 0;
        selection.each(function(root) {
            const x = scaleLinear().range([0, chartWidth]);
            const y = scaleLinear().range([0, cellHeight]);

            reappraiseNode(root);

            if (sort) {
                root.sort(doSort);
            };

            p(root);

            const kx = chartWidth / (root.x1 - root.x0);
            const width = (d) => (d.x1 - d.x0) * kx - 1;

            const descendants = filterNodes(root);
            const svg = select(this).select('svg');
            svg.attr('width', chartWidth);

            let g = svg.selectAll('g').data(descendants, d => d.id);

            // if height is not set: set height on first update, after nodes were filtered by minFrameSize
            if (!chartHeight || resetHeightOnZoom) {
                const maxDepth = Math.max(...descendants.map(n => n.depth));

                chartHeight = (maxDepth + 1) * cellHeight + 2;

                svg.attr('height', chartHeight);
            }

            g.transition()
                .duration(updateTransitionDuration / 2)
                .ease(transitionEase)
                .attr('transform', d => 'translate(' + x(d.x0) + ',' + (inverted ? y(d.depth) : (chartHeight - y(d.depth) - cellHeight)) + ')');
            g.select('rect')
                .transition()
                .duration(updateTransitionDuration / 2)
                .ease(transitionEase)
                .attr('width', width);
            g.select('foreignObject')
                .style('opacity', d => width(d) < 20 ? 0 : 1)
                .transition()
                .duration(updateTransitionDuration / 2)
                .ease(transitionEase)
                .attr('width', width);

            const node = g.enter()
                .append('svg:g')
                .attr('transform', d => 'translate(' + x(d.x0) + ',' + (inverted ? y(d.depth) : (chartHeight - y(d.depth) - cellHeight)) + ')');

            node
                .attr('opacity', 0)
                .transition()
                .delay(updateTransitionDuration / 5)
                .duration(updateTransitionDuration / 2)
                .attr('opacity', 1);

            node.append('svg:rect')
                .attr('width', width);

            if (!tooltip) {
                node.append('svg:title');
            }

            node.append('foreignObject')
                .attr('width', width)
                .style('opacity', d => width(d) < 20 ? 0 : 1)
                .append('xhtml:div');

            // Now we have to re-select to see the new elements (why?).
            g = svg.selectAll('g').data(descendants, d => d.id);

            g.attr('width', width)
                .attr('height', cellHeight)
                .attr('name', d => getName(d))
                .attr('class', 'frame')
                .classed('fade', d => d.data.fade)
                .classed('selected', d => d.data.selected);

            if (!useTransitions) {
                g.attr('opacity', 1);
            }

            g.select('rect')
                .attr('height', cellHeight - 1)
                .attr('fill', d => colorMapper(d));

            if (!tooltip) {
                g.select('title')
                    .text(labelHandler);
            }

            g.select('foreignObject')
                .attr('height', cellHeight - 1)
                .select('div')
                .attr('class', 'd3-flame-graph-label')
                // .style('display', d => width(d) < 20 ? 'none' : 'block')
                .transition()
                .style('opacity', d => width(d) < 20 ? 0 : 1)
                // .delay(transitionDuration)
                .text(getName);

            g.on('click', (_, d) => {
                if (selected !== d) {
                    if (selected) {
                        selected.data.selected = false;
                    }

                    selected = d;
                    d.data.selected = true;
                } else {
                    selected.data.selected = false;
                    selected = null;
                }

                zoom(d);

                if (typeof clickHandler === 'function') {
                    clickHandler(d);
                }
            });

            g.exit()
                .remove();

            g.on('mouseenter', function(event, d) {
                if (tooltip) {
                    tooltip.show(d, this, event);
                };
                detailsHandler(labelHandler(d));
                if (typeof hoverHandler === 'function') {
                    hoverHandler(d);
                }
            }).on('mouseout', function() {
                if (tooltip) {
                    tooltip.hide();
                };
                detailsHandler(null);
            });
        });
    }

    function merge(data, samples) {
        samples.forEach(function(sample) {
            const node = data.find(function(element) {
                return (element.name === sample.name);
            });

            if (node) {
                node.value += sample.value;
                if (sample.children) {
                    if (!node.children) {
                        node.children = [];
                    }
                    merge(node.children, sample.children);
                }
            } else {
                data.push(sample);
            }
        });
    }

    function forEachNode(node, f) {
        f(node);
        let children = node.children;
        if (children) {
            const stack = [children];
            let count; let child; let grandChildren;
            while (stack.length) {
                children = stack.pop();
                count = children.length;
                while (count--) {
                    child = children[count];
                    f(child);
                    grandChildren = child.children;
                    if (grandChildren) {
                        stack.push(grandChildren);
                    }
                }
            }
        }
    }

    function adoptNode(node) {
        let id = 0;
        forEachNode(node, function(n) {
            n.id = id++;
        });
    }

    function reappraiseNode(root) {
        let node; let children; let grandChildren; let childrenValue; let i; let j; let child; let childValue;
        const stack = [];
        const included = [];
        const excluded = [];
        const compoundValue = !selfValue;
        let item = root.data;
        if (item.hide) {
            root.value = 0;
            children = root.children;
            if (children) {
                excluded.push(children);
            }
        } else {
            root.value = item.fade ? 0 : getValue(item);
            stack.push(root);
        }
        // First DFS pass:
        // 1. Update node.value with node's self value
        // 2. Populate excluded list with children under hidden nodes
        // 3. Populate included list with children under visible nodes
        while ((node = stack.pop())) {
            children = node.children;
            if (children && (i = children.length)) {
                childrenValue = 0;
                while (i--) {
                    child = children[i];
                    item = child.data;
                    if (item.hide) {
                        child.value = 0;
                        grandChildren = child.children;
                        if (grandChildren) {
                            excluded.push(grandChildren);
                        }
                        continue;
                    }
                    if (item.fade) {
                        child.value = 0;
                    } else {
                        childValue = getValue(item);
                        child.value = childValue;
                        childrenValue += childValue;
                    }
                    stack.push(child);
                }
                // Here second part of `&&` is actually checking for `node.data.fade`. However,
                // checking for node.value is faster and presents more oportunities for JS optimizer.
                if (compoundValue && node.value) {
                    node.value -= childrenValue;
                }
                included.push(children);
            }
        }
        // Postorder traversal to compute compound value of each visible node.
        i = included.length;
        while (i--) {
            children = included[i];
            childrenValue = 0;
            j = children.length;
            while (j--) {
                childrenValue += children[j].value;
            }
            children[0].parent.value += childrenValue;
        }
        // Continue DFS to set value of all hidden nodes to 0.
        while (excluded.length) {
            children = excluded.pop();
            j = children.length;
            while (j--) {
                child = children[j];
                child.value = 0;
                grandChildren = child.children;
                if (grandChildren) {
                    excluded.push(grandChildren);
                }
            }
        }
    }

    function processData() {
        selection.datum((data) => {
            if (data.constructor.name !== 'Node') {
                // creating a root hierarchical structure
                const root = hierarchy(data, getChildren);

                // augumenting nodes with ids
                adoptNode(root);

                // calculate actual value
                reappraiseNode(root);

                // store value for later use
                root.originalValue = root.value;

                // computing deltas for differentials
                if (computeDelta) {
                    root.eachAfter((node) => {
                        let sum = getDelta(node);
                        const children = node.children;
                        let i = children && children.length;
                        while (--i >= 0) {
                            sum += children[i].delta;
                        };
                        node.delta = sum;
                    });
                }

                // setting the bound data for the selection
                return root;
            }
        });
    }

    function chart(s) {
        if (!arguments.length) {
            return chart;
        }

        // saving the selection on `.call`
        selection = s;

        // processing raw data to be used in the chart
        processData();

        // create chart svg
        selection.each(function(/* data */) {
            if (select(this).select('svg').size() === 0) {
                const svg = select(this)
                    .append('svg:svg')
                    .attr('width', chartWidth)
                    .attr('class', 'partition d3-flame-graph');

                if (chartHeight) {
                    svg.attr('height', chartHeight);
                }

                if (tooltip) {
                    svg.call(tooltip);
                };
            }
        });

        // first draw
        update();
    }

    chart.height = function(_) {
        if (!arguments.length) {
            return chartHeight;
        }
        chartHeight = _;
        return chart;
    };

    chart.width = function(_) {
        if (!arguments.length) {
            return chartWidth;
        }
        chartWidth = _;
        return chart;
    };

    chart.cellHeight = function(_) {
        if (!arguments.length) {
            return cellHeight;
        }
        cellHeight = _;
        return chart;
    };

    chart.tooltip = function(_) {
        if (!arguments.length) {
            return tooltip;
        }
        if (typeof _ === 'function') {
            tooltip = _;
        }
        return chart;
    };

    chart.transitionDuration = function(_) {
        if (!arguments.length) {
            return transitionDuration;
        }
        transitionDuration = _;
        return chart;
    };

    chart.transitionEase = function(_) {
        if (!arguments.length) {
            return transitionEase;
        }
        transitionEase = _;
        return chart;
    };

    chart.sort = function(_) {
        if (!arguments.length) {
            return sort;
        }
        sort = _;
        return chart;
    };

    chart.inverted = function(_) {
        if (!arguments.length) {
            return inverted;
        }
        inverted = _;
        return chart;
    };

    chart.computeDelta = function(_) {
        if (!arguments.length) {
            return computeDelta;
        }
        computeDelta = _;
        return chart;
    };

    chart.setLabelHandler = function(_) {
        if (!arguments.length) {
            return labelHandler;
        }
        labelHandler = _;
        return chart;
    };
    // Kept for backwards compatibility.
    chart.label = chart.setLabelHandler;

    chart.search = function(term) {
        const searchResults = [];
        let searchSum = 0;
        let totalValue = 0;
        selection.each(function(data) {
            const res = searchTree(data, term);
            searchResults.push(...res[0]);
            searchSum += res[1];
            totalValue += data.originalValue;
        });
        searchHandler(searchResults, searchSum, totalValue);
        update();
    };

    chart.findById = function(id) {
        if (typeof (id) === 'undefined' || id === null) {
            return null;
        }
        let found = null;
        selection.each(function(data) {
            if (found === null) {
                found = findTree(data, id);
            }
        });
        return found;
    };

    chart.clear = function() {
        detailsHandler(null);
        selection.each(function(root) {
            clear(root);
            update();
        });
    };

    chart.zoomTo = function(d) {
        zoom(d);
    };

    chart.resetZoom = function() {
        selection.each(function(root) {
            zoom(root); // zoom to root
        });
    };

    chart.onClick = function(_) {
        if (!arguments.length) {
            return clickHandler;
        }
        clickHandler = _;
        return chart;
    };

    chart.onZoom = function(_) {
        if (!arguments.length) {
            return zoomHandler;
        }
        zoomHandler = _;
        return chart;
    };

    chart.onHover = function(_) {
        if (!arguments.length) {
            return hoverHandler;
        }
        hoverHandler = _;
        return chart;
    };

    chart.merge = function(data) {
        if (!selection) {
            return chart;
        }

        // TODO: Fix merge with zoom
        // Merging a zoomed chart doesn't work properly, so
        //  clearing zoom before merge.
        // To apply zoom on merge, we would need to set hide
        //  and fade on new data according to current data.
        // New ids are generated for the whole data structure,
        //  so previous ids might not be the same. For merge to
        //  work with zoom, previous ids should be maintained.
        this.resetZoom();

        // Clear search details
        // Merge requires a new search, updating data and
        //  the details handler with search results.
        // Since we don't store the search term, can't
        //  perform search again.
        searchDetails = null;
        detailsHandler(null);

        selection.datum((root) => {
            merge([root.data], [data]);
            return root.data;
        });
        processData();
        update();
        return chart;
    };

    chart.render = function() {
        update(false);
    };

    chart.update = function(data) {
        if (!selection) {
            return chart;
        }
        if (data) {
            selection.datum(data);
            processData();
        }
        update();
        return chart;
    };

    chart.destroy = function() {
        if (!selection) {
            return chart;
        }
        if (tooltip) {
            tooltip.hide();
            if (typeof tooltip.destroy === 'function') {
                tooltip.destroy();
            }
        }
        selection.selectAll('svg').remove();
        return chart;
    };

    chart.setColorMapper = function(_) {
        if (!arguments.length) {
            colorMapper = originalColorMapper;
            return chart;
        }
        colorMapper = (d) => {
            const originalColor = originalColorMapper(d);
            return _(d, originalColor);
        };
        return chart;
    };
    // Kept for backwards compatibility.
    chart.color = chart.setColorMapper;

    chart.setColorHue = function(_) {
        if (!arguments.length) {
            colorHue = null;
            return chart;
        }
        colorHue = _;
        return chart;
    };

    chart.minFrameSize = function(_) {
        if (!arguments.length) {
            return minFrameSize;
        }
        minFrameSize = _;
        return chart;
    };

    chart.setDetailsElement = function(_) {
        if (!arguments.length) {
            return detailsElement;
        }
        detailsElement = _;
        return chart;
    };
    // Kept for backwards compatibility.
    chart.details = chart.setDetailsElement;

    chart.selfValue = function(_) {
        if (!arguments.length) {
            return selfValue;
        }
        selfValue = _;
        return chart;
    };

    chart.resetHeightOnZoom = function(_) {
        if (!arguments.length) {
            return resetHeightOnZoom;
        }
        resetHeightOnZoom = _;
        return chart;
    };

    chart.scrollOnZoom = function(_) {
        if (!arguments.length) {
            return scrollOnZoom;
        }
        scrollOnZoom = _;
        return chart;
    };

    chart.getName = function(_) {
        if (!arguments.length) {
            return getName;
        }
        getName = _;
        return chart;
    };

    chart.getValue = function(_) {
        if (!arguments.length) {
            return getValue;
        }
        getValue = _;
        return chart;
    };

    chart.getChildren = function(_) {
        if (!arguments.length) {
            return getChildren;
        }
        getChildren = _;
        return chart;
    };

    chart.getLibtype = function(_) {
        if (!arguments.length) {
            return getLibtype;
        }
        getLibtype = _;
        return chart;
    };

    chart.getDelta = function(_) {
        if (!arguments.length) {
            return getDelta;
        }
        getDelta = _;
        return chart;
    };

    chart.setSearchHandler = function(_) {
        if (!arguments.length) {
            searchHandler = originalSearchHandler;
            return chart;
        }
        searchHandler = _;
        return chart;
    };

    chart.setDetailsHandler = function(_) {
        if (!arguments.length) {
            detailsHandler = originalDetailsHandler;
            return chart;
        }
        detailsHandler = _;
        return chart;
    };

    chart.setSearchMatch = function(_) {
        if (!arguments.length) {
            searchMatch = originalSearchMatch;
            return chart;
        }
        searchMatch = _;
        return chart;
    };

    return chart;
}
