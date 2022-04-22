// fork of https://github.com/spiermar/d3-flame-graph

import { generateColorVector } from './colorUtils';
import { calculateColor } from './colorScheme';

class FrameNode {
    constructor(parent, data) {
        this.parent = parent;
        this.next = null;
        this.nextSibling = null;
        this.data = data;
        this.value = data.totalTime;
        this.depth = 0;
        this.x0 = 0;
        this.x1 = 1;
        // this.fade = false;
        // this.selected = false;
    }
}

export default function() {
    let d3Selection = null; // selection
    let chartWidth = 960; // graph width
    let minFrameSize = 2;
    let tooltip = null; // tooltip
    let sort = false;
    let inverted = false; // invert the graph direction
    let clickHandler = null;
    let zoomHandler = null;
    let hoverHandler = null;
    let resetHeightOnZoom = false;
    let scrollOnZoom = false;
    let zoomStart = 0;
    let zoomEnd = 1;
    let colorHue = null;
    let pointerNode = null;
    let selectedNode = null;
    let selectedNodesStack = [];
    let rootFrameNode = null;
    let chartEl = null;
    const fadedNodes = new Set();
    const frameEls = new Map();
    const frameNodeByEl = new WeakMap();

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

    let labelHandler = function(d) {
        return getName(d) + ' (' + (100 * (getValue(d) / getValue(rootFrameNode))).toFixed(2) + '%, ' + getValue(d) + ' ms)';
    };

    let colorMapper = function(d) {
        return d.highlight ? '#E600E6' : colorHash(d.name, getLibtype(d));
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

        // if (scrollOnZoom) {
        //     const chartOffset = select(this).select('svg')._groups[0][0].parentNode.offsetTop;
        //     const maxFrames = (window.innerHeight - chartOffset) / cellHeight;
        //     const frameOffset = (node.height - maxFrames + 10) * cellHeight; // TODO: we don't compute height for now

        //     window.scrollTo({
        //         top: chartOffset + frameOffset,
        //         left: 0,
        //         behavior: 'smooth'
        //     });
        // }

        if (typeof zoomHandler === 'function') {
            zoomHandler(node);
        }
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

    function filterNodes(root, minScale) {
        const minValue = (zoomEnd - zoomStart) * root.value * minScale;
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

    function update() {
        const widthScale = 1 / chartWidth;
        const xScale = 1 / (zoomEnd - zoomStart);
        const xOffset = zoomStart * xScale;
        const nodes = filterNodes(rootFrameNode, minFrameSize * widthScale);
        const removeFrames = new Set(frameEls.keys());
        const enterFramesEl =
            chartEl.querySelector('.frames-group:empty') ||
            document.createElement('div');
        let maxDepth = 0;

        enterFramesEl.className = 'frames-group frames-group_init-enter-state';
        setTimeout(() => enterFramesEl.classList.remove('frames-group_init-enter-state'), 1);

        for (const frameNode of nodes) {
            let el = frameEls.get(frameNode);
            const className = `frame${frameNode.fade ? ' fade' : ''}${frameNode.selected ? ' selected' : ''}`;
            const x0 = Math.max(0, frameNode.x0 * xScale - xOffset);
            const x1 = Math.max(0, frameNode.x1 * xScale - xOffset);

            maxDepth = Math.max(maxDepth, frameNode.depth);

            if (el === undefined) {
                // add
                el = document.createElement('div');
                el.className = className;
                el.style.setProperty('--x0', x0);
                el.style.setProperty('--x1', x1);
                el.style.setProperty('--depth', frameNode.depth);
                el.style.setProperty('--color', colorMapper(frameNode));

                const divEl = document.createElement('div');

                divEl.className = 'frame-label';
                divEl.textContent = frameNode.name;

                // foreignObjectEl.append(divEl);
                el.append(divEl);
                enterFramesEl.append(el);

                frameNodeByEl.set(el, frameNode);
                frameEls.set(frameNode, el);
            } else {
                // update
                el.className = className;
                el.style.setProperty('--x0', x0);
                el.style.setProperty('--x1', x1);
            }

            removeFrames.delete(frameNode);
        }

        for (const frameNode of removeFrames) {
            frameEls.get(frameNode).remove();
            frameEls.delete(frameNode);
        }

        chartEl.append(enterFramesEl);
        chartEl.style.setProperty('--max-depth', maxDepth);
        chartEl.style.setProperty('--width-scale', widthScale);
        chartEl.classList
            .toggle('first-enter', !frameEls.size);
    }

    function processData(rootData) {
        pointerNode = null;
        selectedNode = null;
        selectedNodesStack = [];
        rootFrameNode = null;
        fadedNodes.clear();

        // creating a precomputed hierarchical structure
        let parent = rootFrameNode = new FrameNode(null, rootData);
        parent.name = getName(rootData);

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
                    const child = new FrameNode(parent, childData);

                    child.depth = parent.depth + 1;
                    child.x0 = x0;
                    child.x1 = x0 += child.value / rootFrameNode.value;
                    child.name = getName(childData);

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

        return rootFrameNode;
    }

    function chart(containerEl) {
        // create chart element
        chartEl = containerEl.appendChild(document.createElement('div'));
        chartEl.className = 'flamechart';

        const findFrameNodeByEl = (cursor, rootEl) => {
            while (cursor && cursor !== rootEl) {
                if (frameNodeByEl.has(cursor)) {
                    return frameNodeByEl.get(cursor);
                }

                cursor = cursor.parentNode;
            }
        };
        chartEl.addEventListener('click', function(event) {
            const frameNode = findFrameNodeByEl(event.target, this);

            if (!frameNode) {
                return;
            }

            if (selectedNode !== frameNode && frameNode !== rootFrameNode) {
                if (selectedNode !== null) {
                    selectedNode.selected = false;

                    selectedNodesStack = selectedNodesStack
                        .filter(item => item.depth < frameNode.depth);

                    if (selectedNode.depth < frameNode.depth) {
                        selectedNodesStack.push(selectedNode);
                    }
                }

                selectedNode = frameNode;
                selectedNode.selected = true;
            } else if (selectedNode === frameNode) {
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
                clickHandler(frameNode);
            } else {
                zoom(selectedNode || rootFrameNode);
            }
        });
        chartEl.addEventListener('pointermove', function(event) {
            if (pointerNode === event.target) {
                return;
            }

            pointerNode = event.target;
            const frameNode = findFrameNodeByEl(event.target, this);

            if (!frameNode) {
                return;
            }

            if (tooltip) {
                tooltip.show(frameNode);
            }

            if (typeof hoverHandler === 'function') {
                hoverHandler(frameNode);
            }
        });
        chartEl.addEventListener('pointerout', function() {
            pointerNode = null;

            if (tooltip) {
                tooltip.hide();
            }
        });

        return chart;
    }

    chart.setData = function(data) {
        processData(data || {});
        update();
    };

    chart.width = function(_) {
        if (!arguments.length) {
            return chartWidth;
        }
        chartWidth = _;
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

    chart.clear = function() {
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
        if (data) {
            d3Selection.datum(data);
            processData();
        }
        update();
        return chart;
    };

    chart.destroy = function() {
        if (tooltip) {
            tooltip.hide();
            if (typeof tooltip.destroy === 'function') {
                tooltip.destroy();
            }
        }

        chartEl.remove();
        chartEl = null;

        rootFrameNode = null;
        pointerNode = null;
        selectedNode = null;
        selectedNodesStack = [];
        fadedNodes.clear();

        clickHandler = null;
        zoomHandler = null;
        hoverHandler = null;

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

    return chart;
}
