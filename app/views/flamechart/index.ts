import { CallTree } from '../../prepare/computations/call-tree';
import { generateColorVector, calculateColor } from './color-utils';
import { EventEmitter } from './event-emmiter';

type FrameElement = HTMLElement;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FrameData = any;
type FrameColorGenerator<T> = (frame: T, colorHue: string | null) => string;
type SetDataOptions = {
    name?(data: FrameData): string;
    value?(data: FrameData): number;
    offset?(data: FrameData, parentData: FrameData): number;
    children?(data: FrameData): FrameData[] | null | undefined;
    childrenSort?: true | 'name' | 'value' | ((a: number, b: number) => number);
}
type Events = {
    render<T>(rootEl: Element | null, rootFrame: Frame<T> | null, rootValue: number): void;
    select(nodeIndex: number, prevNodeIndex: number): void;
    zoom(nodeIndex: number, start: number, end: number): void;
    'frame:click'(nodeIndex: number, element: FrameElement, event: MouseEvent): void;
    'frame:enter'(nodeIndex: number, element: FrameElement): void;
    'frame:leave'(): void;
    destroy(): void;
}

type Frame<T> = {
    nodeIndex: number;
    value: T;
    name: string;
    color: string;
    x0: number;
    x1: number;
    depth: number;
};

const defaultGetName: Exclude<SetDataOptions['name'], undefined> = (frameData: FrameData) => frameData.name;
const defaultGetValue: Exclude<SetDataOptions['value'], undefined> = (frameData: FrameData) => frameData.value;

function ensureFunction<T, U>(value: T, fallback: U) {
    return typeof value === 'function' ? value : fallback;
}

function defaultColorMapper(frame: FrameData, colorHue: string | null = null) {
    const { name } = frame;
    const vector = generateColorVector(name);
    const libtype = undefined;

    // default when libtype is not in use
    let hue = colorHue || 'warm';

    if (!colorHue && !(typeof libtype === 'undefined' || libtype === '')) {
        // Select hue. Order is important.
        hue = 'red';
        if (typeof name !== 'undefined' && name && name.indexOf('::') !== -1) {
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

    return calculateColor(hue, vector);
}

export class FlameChart<T> extends EventEmitter<Events> {
    el: HTMLElement;
    #resizeObserver: ResizeObserver | null = null;

    #colorMapper: FrameColorGenerator<T> = defaultColorMapper;
    #colorHue: string | null = null;
    #scheduleRenderTimer: number | null = null;
    #childrenSort: ((a: number, b: number) => number) | null = null;
    #lastVisibleFramesEpoch = 0;
    #epoch = 0;

    #width = 0; // graph width
    #minFrameWidth = 2;
    zoomStart = 0;
    zoomEnd = 1;

    #getValue = defaultGetValue;

    tree: CallTree<T>;
    nodesMaxDepth: number;
    nodesDepth: Uint32Array;
    nodesValue: Uint32Array;
    nodesX: Uint32Array;
    children: Uint32Array;
    childrenOffset: Uint32Array;
    childrenComputed: Uint32Array;
    nodesNames: string[];
    nodesColors: string[];

    zoomedNode = 0;
    zoomedNodesStack: number[] = [];
    selectedNode = -1;
    frameEls = new Map<number, HTMLElement>();
    frameByEl = new WeakMap<Node, Frame<T>>();

    constructor() {
        super();

        // create chart element
        this.el = this.createElement(this);
        this.on('frame:click', (nodeIndex, _, event) => {
            if (event.metaKey) {
                this.selectFrame(nodeIndex);
            } else {
                this.zoomFrame(nodeIndex, true);
            }
        });
    }

    createElement(chart: FlameChart<T>) {
        const chartEl = document.createElement('div');

        chartEl.className = 'flamechart';
        chartEl.addEventListener('click', event => {
            const result = chart.findFrameByEl(event.target as Node);

            if (result !== null) {
                chart.emit('frame:click', result.frame.nodeIndex, result.element as FrameElement, event);
            }
        }, true);
        chartEl.addEventListener('pointerenter', event => {
            const result = chart.findFrameByEl(event.target as Node);

            if (result !== null) {
                chart.emit('frame:enter', result.frame.nodeIndex, result.element as FrameElement);
            }
        }, true);
        chartEl.addEventListener('pointerleave', () => {
            chart.emit('frame:leave');
        }, true);
        // chartEl.addEventListener('mousewheel', (e) => {
        //     const deltaY = (e as WheelEvent).deltaY;
        //     const scale = Math.sign(deltaY) < 0 ? 0.99 : 1.01;
        //     const curDelta = chart.zoomEnd - chart.zoomStart;
        //     const newDelta = Math.max(0.0001, Math.min(1, curDelta));

        //     chart.zoomStart = chart.zoomStart + (curDelta - newDelta * scale) / 2;
        //     chart.zoomEnd = chart.zoomEnd - (curDelta - newDelta * scale) / 2;
        //     const t = Date.now();
        //     chart.render();
        //     console.log(Date.now() - t, { deltaY, scale, curDelta, newDelta }, [chart.zoomStart, chart.zoomEnd]);

        //     e.preventDefault();

        //     const xScale = 1 / (chart.zoomEnd - chart.zoomStart);
        //     const xOffset = chart.zoomStart * xScale;

        //     // add / update frame elements
        //     for (const [frame, frameEl] of chart.frameEls) {
        //         const x0 = Math.max(0, frame.x0 * xScale - xOffset);
        //         const x1 = Math.max(0, frame.x1 * xScale - xOffset);

        //         if (frameEl) {
        //             // update
        //             frameEl.style.setProperty('--x0', x0.toFixed(8));
        //             frameEl.style.setProperty('--x1', x1.toFixed(8));
        //         }
        //     }
        // });

        if (typeof ResizeObserver === 'function') {
            this.#resizeObserver = new ResizeObserver(entries => {
                const newWidth = entries[entries.length - 1].contentRect.width;

                if (typeof newWidth === 'number' && this.#width !== newWidth) {
                    this.#width = newWidth;
                    this.scheduleRender();
                }
            });
            this.#resizeObserver.observe(chartEl);
        }

        return chartEl;
    }

    findFrameByEl(cursor: Node | null) {
        if (this.el.contains(cursor)) {
            while (cursor !== null && cursor !== this.el) {
                if (this.frameByEl.has(cursor)) {
                    return {
                        element: cursor,
                        frame: this.frameByEl.get(cursor) as Frame<T>
                    };
                }

                cursor = cursor.parentNode;
            }
        }

        return null;
    }

    selectFrame(nodeIndex: number) {
        const prevSelected = this.selectedNode;
        const subjectId = this.tree.nodes[nodeIndex];
        const selectedSubjectId = this.tree.nodes[this.selectedNode];

        if (selectedSubjectId !== subjectId && nodeIndex !== 0) {
            this.selectedNode = nodeIndex;
        } else {
            this.selectedNode = -1;
        }

        this.emit('select', this.selectedNode, prevSelected);
        this.scheduleRender();

        return this.selectedNode;
    }

    resetFrameRefs() {
        this.zoomedNode = 0;
        this.zoomedNodesStack = [];
        this.selectedNode = -1;
        this.frameByEl = new WeakMap();
        this.frameEls.clear();
    }

    setData(tree: CallTree<T>, options?: SetDataOptions) {
        // this.resetFrameRefs();

        options = options || {};

        const getName = ensureFunction(options.name, defaultGetName);
        const getValue = ensureFunction(options.value, defaultGetValue);
        this.#childrenSort =
            options.childrenSort === true || options.childrenSort === 'value'
                ? (a: number, b: number) => values[b] - values[a]
                : options.childrenSort === 'name'
                    ? (a: number, b: number) => {
                        const nameA = names[a];
                        const nameB = names[b];

                        return nameA > nameB ? 1 : nameA < nameB ? -1 : 0;
                    }
                    : ensureFunction(options.childrenSort, null);

        const nodes = tree.nodes;
        const parent = tree.parent;
        const subtreeSize = tree.subtreeSize;
        const depth = new Uint32Array(nodes.length);
        const children = new Uint32Array(nodes.length);
        const childrenOffset = new Uint32Array(nodes.length);
        const childrenComputed = new Uint32Array(nodes.length);
        const names = tree.dictionary.map(getName);
        const values = new Uint32Array(nodes.length);
        const x = new Uint32Array(nodes.length);
        const nodesLength = nodes.length;
        let maxDepth = 0;
        let childrenCursor = 0;

        for (let i = 0; i < nodes.length; i++) {
            const nodeDepth = depth[parent[i]] + (i !== 0 ? 1 : 0);
            let cursor = i + 1;

            depth[i] = nodeDepth;
            values[i] = getValue(i);

            if (maxDepth < nodeDepth) {
                maxDepth = nodeDepth;
            }

            if (cursor !== nodesLength && parent[cursor] === i) {
                const end = i + subtreeSize[i];

                while (cursor <= end) {
                    children[childrenCursor++] = cursor;
                    cursor += subtreeSize[cursor] + 1;
                }
            }

            childrenOffset[i] = childrenCursor;
        }

        this.#epoch++;
        this.#getValue = getValue;
        this.nodesMaxDepth = maxDepth;
        this.nodesDepth = depth;
        this.nodesValue = values;
        this.nodesX = x;
        this.children = children;
        this.childrenOffset = childrenOffset;
        this.childrenComputed = childrenComputed;
        this.nodesNames = names;
        this.nodesColors = tree.dictionary.map(entry => this.#colorMapper(entry, this.#colorHue));
        this.tree = tree;

        this.scheduleRender();
    }

    resetValues() {
        this.#epoch++;
        this.scheduleRender();
    }

    #computeChildren(nodeIdx: number, nodeX: number) {
        const { nodesX, nodesValue, children, childrenOffset, childrenComputed } = this;
        const { subtreeSize } = this.tree;
        const getValue = this.#getValue;

        // if children is not computed before, then sort them and calculate x and width
        if (childrenComputed[nodeIdx] === 0) {
            childrenComputed[nodeIdx] = 1;

            if (subtreeSize[nodeIdx] > 0) {
                const offsetEnd = childrenOffset[nodeIdx];
                const count = offsetEnd - (nodeIdx === 0 ? 0 : childrenOffset[nodeIdx - 1]);
                const offset = offsetEnd - count;

                if (count > 1) {
                    const array = this.children.subarray(offset, offset + count);

                    for (let j = 0; j < array.length; j++) {
                        const childId = array[j];

                        nodesValue[childId] = getValue(childId);
                    }

                    if (this.#childrenSort !== null) {
                        array.sort(this.#childrenSort);
                    }

                    for (let j = 0, childX = nodeX; j < array.length; j++) {
                        const childId = array[j];

                        nodesX[childId] = childX;
                        childX += nodesValue[childId];
                    }
                } else if (count === 1) {
                    // no need for sort & loop through children
                    const childId = children[offset];

                    nodesValue[childId] = getValue(childId);
                    nodesX[childId] = nodeX;
                }
            }
        }
    }

    #syncChildrenComputations() {
        if (this.#lastVisibleFramesEpoch !== this.#epoch) {
            this.#lastVisibleFramesEpoch = this.#epoch;
            this.childrenComputed.fill(0);

            // this.nodesValue[0] = this.#getValue(0);
            this.#computeChildren(0, 0);
            let rootValue = 0;
            for (const childIndex of this.tree.children(0)) {
                rootValue += this.nodesValue[childIndex];
            }
            this.nodesValue[0] = rootValue;

            if (this.zoomedNode > 0) {
                for (const ancestorIdx of [...this.tree.ancestors(this.zoomedNode)].reverse()) {
                    this.#computeChildren(ancestorIdx, this.nodesX[ancestorIdx]);
                }

                this.zoomFrame(this.zoomedNode);
            }
        }
    }

    getVisibleFrames(
        start = this.zoomStart,
        end = this.zoomEnd,
        minScale = 0
    ) {
        if (this.tree === null) {
            return [];
        }

        const { nodesX, nodesValue, nodesDepth } = this;
        const { dictionary, nodes, subtreeSize } = this.tree;

        this.#syncChildrenComputations();

        const rootWidth = nodesValue[0];
        const minValue = (end - start) * rootWidth * minScale;
        const nodeList: Frame<T>[] = [];

        for (let i = 0; i < nodes.length; i++) {
            const nodeValue = nodesValue[i];
            const nodeX = nodesX[i];
            const x0 = nodeX / rootWidth;
            const x1 = (nodeX + nodeValue) / rootWidth;

            if (x0 < end && x1 > start && nodeValue >= minValue) {
                nodeList.push({
                    nodeIndex: i,
                    value: dictionary[nodes[i]],
                    name: this.nodesNames[nodes[i]],
                    color: this.nodesColors[nodes[i]],
                    x0,
                    x1,
                    depth: nodesDepth[i]
                });

                this.#computeChildren(i, nodeX);
            } else {
                i += subtreeSize[i];
            }
        }

        return nodeList;
    }

    scheduleRender() {
        if (this.#scheduleRenderTimer === null) {
            const requestId = requestAnimationFrame(() => {
                if (this.#scheduleRenderTimer === requestId) {
                    // const renderStart = Date.now();

                    this.render();
                    this.#scheduleRenderTimer = null;

                    // if (this.#width) {
                    //     console.log('Flamechart.render()', Date.now() - renderStart);
                    // }
                }
            });

            this.#scheduleRenderTimer = requestId;
        }
    }

    render() {
        this.#syncChildrenComputations();
        this.#scheduleRenderTimer = null;

        if (this.#width === 0 && this.#resizeObserver) {
            return;
        }

        const widthScale = 1 / (this.#width || 1000);
        const xScale = 1 / (this.zoomEnd - this.zoomStart);
        const xOffset = this.zoomStart * xScale;
        const firstEnter = !this.frameEls.size;
        const removeFrameNodeIndecies = new Set(this.frameEls.keys());
        const visibleFrames = this.getVisibleFrames(
            this.zoomStart,
            this.zoomEnd,
            this.#minFrameWidth * widthScale
        );

        const enterFramesBuffer = document.createDocumentFragment();
        const nodes = this.tree.nodes;
        const selectedId = this.selectedNode !== -1 ? nodes[this.selectedNode] : -1;
        let maxDepth = 0;

        // add / update frame elements
        for (const frame of visibleFrames) {
            const nodeIndex = frame.nodeIndex;
            const className = nodeIndex === 0
                ? 'frame'
                : `frame${
                    nodeIndex < this.zoomedNode ? ' fade' : ''
                }${
                    this.zoomedNode === nodeIndex ? ' zoomed' : ''
                }${
                    nodes[nodeIndex] === selectedId ? ' similar' : ''
                }`;
            const x0 = Math.max(0, frame.x0 * xScale - xOffset);
            const x1 = Math.max(0, frame.x1 * xScale - xOffset);
            let frameEl = this.frameEls.get(frame.nodeIndex);

            if (frame.depth > maxDepth) {
                maxDepth = frame.depth;
            }

            if (frameEl === undefined) {
                // enter (add)
                frameEl = document.createElement('div');
                frameEl.className = className;
                frameEl.style.setProperty('--x0', x0.toFixed(8));
                frameEl.style.setProperty('--x1', x1.toFixed(8));
                frameEl.style.setProperty('--depth', String(frame.depth));
                frameEl.style.setProperty('--color', frame.color);

                const labelEl = frameEl.appendChild(document.createElement('div'));

                labelEl.className = 'frame-label';
                labelEl.textContent = frame.name;

                enterFramesBuffer.append(frameEl);
                this.frameByEl.set(frameEl, frame);
                this.frameEls.set(frame.nodeIndex, frameEl);
            } else {
                // update
                frameEl.className = className;
                frameEl.style.setProperty('--x0', x0.toFixed(8));
                frameEl.style.setProperty('--x1', x1.toFixed(8));
            }

            removeFrameNodeIndecies.delete(frame.nodeIndex);
        }

        // remove non-visible frames
        for (const nodeIndex of removeFrameNodeIndecies) {
            this.frameEls.get(nodeIndex)?.remove();
            this.frameEls.delete(nodeIndex);
        }

        // update chart level state
        this.el.classList.toggle('first-enter', firstEnter);
        this.el.style.setProperty('--max-depth', String(maxDepth));
        this.el.style.setProperty('--width-scale', widthScale.toFixed(8));

        // finalize enter frames group element
        if (enterFramesBuffer.firstChild !== null) {
            const enterFramesGroupEl =
                this.el.querySelector('.frames-group:empty') ||
                document.createElement('div');

            enterFramesGroupEl.append(enterFramesBuffer);
            enterFramesGroupEl.className = 'frames-group frames-group_init-enter-state';
            setTimeout(() => enterFramesGroupEl.classList.remove('frames-group_init-enter-state'), 1);
            this.el.prepend(enterFramesGroupEl);
        }

        // emit render event
        this.emit('render',
            this.frameEls.get(0)?.firstElementChild || null,
            this.frameByEl.get(this.frameEls.get(0) as Node) || null,
            this.nodesValue[0]
        );
    }

    zoomFrame(nodeIndex = 0, toggle = false) {
        const rootValue = this.nodesValue[0];
        const nodesDepth = this.nodesDepth;
        const prevZoomedNode = this.zoomedNode;
        const prevZoomStart = this.zoomStart;
        const prevZoomEnd = this.zoomEnd;

        if (this.zoomedNode !== nodeIndex && nodeIndex !== 0) {
            if (this.zoomedNode !== 0) {
                this.zoomedNodesStack = this.zoomedNodesStack
                    .filter(item => nodesDepth[item] < nodesDepth[nodeIndex]);

                if (nodesDepth[this.zoomedNode] < nodesDepth[nodeIndex]) {
                    this.zoomedNodesStack.push(this.zoomedNode);
                }
            }

            this.zoomedNode = nodeIndex;
        } else if (this.zoomedNode === nodeIndex) {
            if (toggle) {
                this.zoomedNode = 0;

                if (this.zoomedNodesStack.length > 0) {
                    this.zoomedNode = this.zoomedNodesStack.pop() as number;
                }
            } else {
                while (this.zoomedNode !== 0 && this.nodesValue[this.zoomedNode] === 0 && this.zoomedNodesStack.length > 0) {
                    this.zoomedNode = this.zoomedNodesStack.pop() as number;
                }

                if (this.nodesValue[this.zoomedNode] === 0) {
                    this.zoomedNode = 0;
                }
            }
        } else if (this.zoomedNode !== 0) {
            this.zoomedNode = 0;
            this.zoomedNodesStack = [];
        }

        this.zoomStart = this.nodesX[this.zoomedNode] / rootValue;
        this.zoomEnd = this.zoomStart + this.nodesValue[this.zoomedNode] / rootValue;

        // emit event
        if (prevZoomedNode !== this.zoomedNode ||
            prevZoomStart !== this.zoomStart ||
            prevZoomEnd !== this.zoomEnd) {
            this.emit('zoom', this.zoomedNode, this.zoomStart, this.zoomEnd);
        }

        // schedule render
        this.scheduleRender();
    }

    resetZoom() {
        this.zoomFrame(0); // zoom to root
    }

    get colorHue() {
        return this.#colorHue;
    }
    set colorHue(colorHue: string | null) {
        this.#colorHue = colorHue;
        this.scheduleRender();
    }

    get colorMapper() {
        return this.#colorMapper;
    }
    set colorMapper(colorMapper: FrameColorGenerator<T>) {
        this.#colorMapper = colorMapper;
        this.scheduleRender();
    }

    get minFrameWidth() {
        return this.#minFrameWidth;
    }
    set minFrameWidth(minWidth: number) {
        this.#minFrameWidth = minWidth;
        this.scheduleRender();
    }

    destroy() {
        this.emit('destroy');

        this.resetFrameRefs();

        if (this.#resizeObserver) {
            this.#resizeObserver.disconnect();
            this.#resizeObserver = null;
        }

        this.el.remove();
        this.el = null as unknown as HTMLElement;
    }
}
