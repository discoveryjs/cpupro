// fork of https://github.com/spiermar/d3-flame-graph

import { select } from 'd3-selection';
import { format } from 'd3-format';
import { ascending } from 'd3-array';
import { Node as FlamechartNode } from 'd3-hierarchy';
import { easeCubic } from 'd3-ease';
import 'd3-transition';
import { generateColorVector } from './colorUtils';
import { calculateColor } from './colorScheme';

export default function() {
    let d3Selection = null; // selection
    let chartWidth = 960; // graph width
    let chartHeight = null; // graph height
    let cellHeight = 19; // cell height
    let tooltip = null; // tooltip
    let transitionDuration = 350;
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
    let zoomStart = 0;
    let zoomEnd = 1;
    let colorHue = null;
    let selectedNode = null;
    let selectedNodesStack = [];
    const fadedNodes = new Set();

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

    function zoom(d) {
        zoomStart = d.x0;
        zoomEnd = d.x1;

        unfadeNodes();
        fadeAncestorNodes(d);
        update();

        if (scrollOnZoom) {
            const chartOffset = select(this).select('svg')._groups[0][0].parentNode.offsetTop;
            const maxFrames = (window.innerHeight - chartOffset) / cellHeight;
            const frameOffset = (d.height - maxFrames + 10) * cellHeight; // TODO: we don't compute height for now

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

    function compareNodes(a, b) {
        if (typeof sort === 'function') {
            return sort(a, b);
        } else if (sort) {
            return ascending(getName(a), getName(b));
        }
    }

    function filterNodes(root) {
        const minValue = (zoomEnd - zoomStart) * root.value * minFrameSize / chartWidth;
        const nodeList = [root];
        let acceptedCount = 0;

        for (const node of nodeList) {
            if (node.x0 < zoomEnd && node.x1 > zoomStart && node.value >= minValue) {
                nodeList[acceptedCount++] = node;

                if (node.children) {
                    nodeList.push(...node.children);
                }
            }
        }

        nodeList.length = acceptedCount;

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
                (inverted ? cellHeight * d.depth : (chartHeight - cellHeight * d.depth - cellHeight)) +
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

    function processData() {
        selectedNode = null;
        d3Selection.datum((data) => {
            if (data.constructor.name !== 'Node') {
                // creating a precomputed hierarchical structure
                const root = new FlamechartNode(data);
                const nodes = [root];
                let id = 0;

                root.id = id++;
                root.fade = false;
                root.selected = false;
                root.value = root.data.value;
                root.x0 = 0;
                root.x1 = 1;

                for (const node of nodes) {
                    let children = getChildren(node.data);

                    if (Array.isArray(children)) {
                        let x0 = node.x0;

                        if (sort) {
                            // use slice() to avoid data mutation
                            children = children.slice().sort(compareNodes);
                        }

                        node.children = children.map(childData => {
                            const child = new FlamechartNode(childData);

                            child.id = id++;
                            child.parent = node;
                            child.depth = node.depth + 1;
                            child.fade = false;
                            child.selected = false;
                            child.value = childData.value;
                            child.x0 = x0;
                            child.x1 = x0 += childData.value / root.value;

                            nodes.push(child);

                            return child;
                        });
                    }
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

                        if (selectedNode.depth < node.depth) {
                            selectedNodesStack.push(selectedNode);
                        } else {
                            selectedNodesStack = selectedNodesStack
                                .filter(item => item.depth >= node.depth);
                        }
                    }

                    node.selected = true;
                    selectedNode = node;
                } else if (selectedNode === node) {
                    selectedNode.selected = false;
                    selectedNode = selectedNodesStack.pop() || null;

                    if (selectedNode !== null) {
                        selectedNode.selected = true;
                    }
                } else if (selectedNode !== null) {
                    selectedNode.selected = false;
                    selectedNode = null;
                }

                if (typeof clickHandler === 'function') {
                    clickHandler(node);
                } else {
                    zoom(selectedNode || root);
                }
            })
            .on('pointermove', function(event) {
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
        if (typeof (id) === 'undefined' || id === null) {
            return null;
        }
        let found = null;
        d3Selection.each(function(data) {
            if (found === null) {
                found = findTree(data, id);
            }
        });
        return found;
    };

    chart.clear = function() {
        detailsHandler(null);
        d3Selection.each(clear);
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

    chart.merge = function(data) {
        if (!d3Selection) {
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

        d3Selection.datum((root) => {
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
        d3Selection.selectAll('svg').remove();
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
