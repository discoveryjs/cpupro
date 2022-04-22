// fork of https://github.com/spiermar/d3-flame-graph

import { select } from 'd3-selection';
import { format } from 'd3-format';
import { easeCubic } from 'd3-ease';
import 'd3-transition';
import { generateColorVector } from './colorUtils';
import { calculateColor } from './colorScheme';

export default function() {
    let d3Selection = null; // selection
    let chartWidth = 960; // graph width
    let chartHeight = null; // graph height
    let cellHeight = 19; // cell height
    let minFrameSize = 2;
    let tooltip = null; // tooltip
    let transitionDuration = 350;
    let transitionEase = easeCubic; // tooltip offset
    let sort = false;
    let inverted = false; // invert the graph direction
    let clickHandler = null;
    let zoomHandler = null;
    let hoverHandler = null;
    let detailsElement = null;
    let searchDetails = null;
    let resetHeightOnZoom = false;
    let scrollOnZoom = false;
    let zoomStart = 0;
    let zoomEnd = 1;
    let colorHue = null;
    let pointerNode = null;
    let selectedNode = null;
    let selectedNodesStack = [];
    const fadedNodes = new Set();

    let getName = function(d) {
        return d.data.name;
    };

    let getValue = function(d) {
        return d.value;
    };

    let getChildren = function(d) {
        return d.children;
    };

    let getLibtype = function(d) {
        return d.data.libtype;
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

    function unfadeNodes() {
        for (const node of fadedNodes) {
            node.fade = false;
        }

        fadedNodes.clear();
    }

    function fadeAncestorNodes(node) {
        let cursor = node.parent;

        while (cursor !== null) {
            fadedNodes.add(cursor);
            cursor.fade = true;
            cursor = cursor.parent;
        }
    }

    function zoom(node) {
        zoomStart = node.x0;
        zoomEnd = node.x1;

        unfadeNodes();
        fadeAncestorNodes(node);
        update();

        if (scrollOnZoom) {
            const chartOffset = select(this).select('svg')._groups[0][0].parentNode.offsetTop;
            const maxFrames = (window.innerHeight - chartOffset) / cellHeight;
            const frameOffset = (node.height - maxFrames + 10) * cellHeight; // TODO: we don't compute height for now

            window.scrollTo({
                top: chartOffset + frameOffset,
                left: 0,
                behavior: 'smooth'
            });
        }

        if (typeof zoomHandler === 'function') {
            zoomHandler(node);
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

    function defaultCompare(nameA, nameB) {
        return nameA > nameB ? 1 : nameA < nameB ? -1 : 0;
    }

    function compareNodes(a, b) {
        if (typeof sort === 'function') {
            return sort(a, b);
        } else if (sort) {
            return defaultCompare(getName(a), getName(b));
        }
    }

    function filterNodes(root) {
        const minValue = (zoomEnd - zoomStart) * root.value * minFrameSize / chartWidth;
        const nodeList = [];
        let node = root;

        while (node !== null) {
            if (node.x0 < zoomEnd && node.x1 > zoomStart && node.value >= minValue) {
                nodeList.push(node);

                node = node.next;
            } else {
                while (node !== null) {
                    if (node.nextSibling !== null) {
                        node = node.nextSibling;
                        break;
                    }

                    node = node.parent;
                }
            }
        }

        return nodeList;
    }

    function update(useTransitions = true) {
        d3Selection.each(function(root) {
            const maxWidth = (zoomEnd - zoomStart) * root.value;
            const widthScale = chartWidth / maxWidth;
            const getNodeWidth = d => Math.min(maxWidth, d.value * widthScale - 1);

            const xScale = chartWidth / (zoomEnd - zoomStart);
            const xOffset = zoomStart * xScale;
            const getNodeTranslate = d => 'translate(' +
                Math.max(0, d.x0 * xScale - xOffset) + ',' +
                (inverted ? cellHeight * d.depth : chartHeight - cellHeight * d.depth - cellHeight) +
            ')';

            const nodes = filterNodes(root);
            const svg = select(this).select('svg');

            svg.attr('width', chartWidth);

            // if height is not set: set height on first update, after nodes were filtered by minFrameSize
            if (!chartHeight || resetHeightOnZoom) {
                let maxDepth = 0;

                for (const node of nodes) {
                    maxDepth = Math.max(maxDepth, node.depth);
                }

                chartHeight = (maxDepth + 1) * cellHeight + 2;

                svg.attr('height', chartHeight);
            }

            // select all frame elements
            let frameEls = svg.selectAll('.frame')
                .data(nodes, d => d.id);

            // update
            let update = frameEls
                .classed('fade', d => d.fade)
                .classed('selected', d => d.selected);

            if (useTransitions) {
                update = update
                    .transition()
                    .duration(transitionDuration)
                    .ease(transitionEase);
            }

            update.attr('transform', getNodeTranslate);

            update.select('rect')
                .attr('width', getNodeWidth);

            update.select('foreignObject')
                .style('opacity', d => getNodeWidth(d) < 20 ? 0 : 1)
                .attr('width', getNodeWidth);

            // enter
            const enter = frameEls.enter()
                .append('svg:g')
                .attr('class', 'frame')
                .attr('transform', getNodeTranslate)
                .classed('fade', d => d.fade)
                .classed('selected', d => d.selected);

            if (useTransitions) {
                enter
                    .attr('opacity', 0)
                    .transition()
                    .delay(transitionDuration / 2)
                    .duration(transitionDuration)
                    .attr('opacity', 1);
            }

            enter.append('svg:rect')
                .attr('width', getNodeWidth)
                .attr('height', cellHeight - 1)
                .attr('fill', d => colorMapper(d));

            enter.append('svg:foreignObject')
                .attr('width', getNodeWidth)
                .attr('height', cellHeight - 1)
                .style('opacity', d => getNodeWidth(d) < 20 ? 0 : 1)
                .append('xhtml:div')
                .attr('class', 'd3-flame-graph-label')
                .text(getName);

            if (!tooltip) {
                enter.append('svg:title')
                    .text(labelHandler);
            }

            // exit
            frameEls.exit()
                .remove();
        });
    }

    class FrameNode {
        constructor(id, parent, data) {
            this.id = id;
            this.parent = parent;
            this.next = null;
            this.nextSibling = null;
            this.data = data;
            this.depth = 0;
            this.fade = false;
            this.selected = false;
            this.value = data.value;
            this.x0 = 0;
            this.x1 = 1;
        }
    }

    function processData() {
        selectedNode = null;
        d3Selection.datum((data) => {
            if (data.constructor.name !== 'Node') {
                // creating a precomputed hierarchical structure
                let id = 1;
                const root = new FrameNode(id++, null, data);
                let parent = root;

                while (parent !== null) {
                    let children = getChildren(parent.data);

                    if (Array.isArray(children)) {
                        if (sort) {
                            // use slice() to avoid data mutation
                            children = children.slice().sort(compareNodes);
                        }

                        let x0 = parent.x0;
                        let prev = null;
                        let parentNext = parent.next;

                        for (const childData of children) {
                            const child = new FrameNode(id++, parent, childData);

                            child.depth = parent.depth + 1;
                            child.x0 = x0;
                            child.x1 = x0 += childData.value / root.value;

                            if (prev === null) {
                                parent.next = child;
                            } else {
                                prev.next = prev.nextSibling = child;
                            }

                            prev = child;
                        }

                        if (prev !== null) {
                            prev.next = parentNext;
                        }
                    }

                    parent = parent.next;
                }

                // setting the bound data for the selection
                return root;
            }
        });
    }

    function chart(s, renderOnInit = true) {
        if (!arguments.length) {
            return chart;
        }

        // saving the selection on `.call`
        d3Selection = s;

        // processing raw data to be used in the chart
        processData();

        // create chart svg
        d3Selection.each(function(/* data */) {
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

        const findNodeByEl = (cursor, rootEl) => {
            while (cursor && cursor !== rootEl) {
                if (cursor.__data__) {
                    return cursor.__data__;
                }

                cursor = cursor.parentNode;
            }
        };
        d3Selection.select('svg')
            .on('click', function(event, root) {
                const node = findNodeByEl(event.target, this);

                if (!node) {
                    return;
                }

                if (selectedNode !== node && node !== root) {
                    if (selectedNode !== null) {
                        selectedNode.selected = false;

                        selectedNodesStack = selectedNodesStack
                            .filter(item => item.depth < node.depth);

                        if (selectedNode.depth < node.depth) {
                            selectedNodesStack.push(selectedNode);
                        }
                    }

                    selectedNode = node;
                    selectedNode.selected = true;
                } else if (selectedNode === node) {
                    selectedNode.selected = false;
                    selectedNode = null;

                    if (selectedNodesStack.length > 0) {
                        selectedNode = selectedNodesStack.pop();
                        selectedNode.selected = true;
                    }
                } else if (selectedNode !== null) {
                    selectedNode.selected = false;
                    selectedNode = null;
                    selectedNodesStack = [];
                }

                if (typeof clickHandler === 'function') {
                    clickHandler(node);
                } else {
                    zoom(selectedNode || root);
                }
            })
            .on('pointermove', function(event) {
                if (pointerNode === event.target) {
                    return;
                }

                pointerNode = event.target;
                const node = findNodeByEl(event.target, this);

                if (!node) {
                    return;
                }

                if (tooltip) {
                    tooltip.show(node, this, event);
                }

                detailsHandler(labelHandler(node));

                if (typeof hoverHandler === 'function') {
                    hoverHandler(node);
                }
            })
            .on('pointerout', function() {
                pointerNode = null;

                if (tooltip) {
                    tooltip.hide();
                }

                detailsHandler(null);
            });

        if (renderOnInit) {
            // first draw
            update();
        }
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

    chart.setLabelHandler = function(_) {
        if (!arguments.length) {
            return labelHandler;
        }
        labelHandler = _;
        return chart;
    };

    chart.search = function(term) {
        const searchResults = [];
        let searchSum = 0;
        let totalValue = 0;
        d3Selection.each(function(data) {
            const res = searchTree(data, term);
            searchResults.push(...res[0]);
            searchSum += res[1];
            totalValue += data.value;
        });
        searchHandler(searchResults, searchSum, totalValue);
        update();
    };

    chart.findById = function(id) {
        if (typeof id !== 'number') {
            return null;
        }

        let found = null;

        d3Selection.each(function(cursor) {
            while (!found && cursor !== null) {
                found = cursor.id === id;
                cursor = cursor.next;
            }
        });

        return found;
    };

    chart.clear = function() {
        detailsHandler(null);
        d3Selection.each(function(cursor) {
            while (cursor !== null) {
                cursor.highlight = false;
                cursor = cursor.next;
            }
        });
        update();
    };

    chart.zoomTo = function(d) {
        zoom(d);
    };

    chart.resetZoom = function() {
        d3Selection.each(function(root) {
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

    chart.render = function() {
        update(false);
    };

    chart.update = function(data) {
        if (!d3Selection) {
            return chart;
        }
        if (data) {
            d3Selection.datum(data);
            processData();
        }
        update();
        return chart;
    };

    chart.destroy = function() {
        if (!d3Selection) {
            return chart;
        }

        if (tooltip) {
            tooltip.hide();
            if (typeof tooltip.destroy === 'function') {
                tooltip.destroy();
            }
        }

        pointerNode = null;
        selectedNode = null;
        selectedNodesStack = [];
        fadedNodes.clear();

        d3Selection.selectAll('svg').remove();
        d3Selection = null;
        clickHandler = null;
        zoomHandler = null;
        hoverHandler = null;
        detailsElement = null;
        searchDetails = null;

        chart = null;
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
