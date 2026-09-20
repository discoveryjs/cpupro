import { CallTree } from '../../prepare/computations/call-tree';
import { generateColorVector, calculateColor } from './color-utils';
import { EventEmitter } from './event-emmiter';
import { SpanLabels, SPAN_LABEL_FONT } from '../track-timeline/labels';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FrameData = any;
type FrameColorGenerator<T> = (frame: T, colorHue: string | null) => string;

type SetDataOptions = {
    name?(data: FrameData): string;
    value?(data: FrameData): number;
    childrenSort?: true | 'name' | 'value' | ((left: number, right: number) => number);
};

type Events = {
    render<T>(rootEl: Element | null, rootFrame: Frame<T> | null, rootValue: number): void;
    select(nodeIndex: number, prevNodeIndex: number): void;
    zoom(nodeIndex: number, start: number, end: number): void;
    'frame:click'(nodeIndex: number, element: HTMLElement, event: MouseEvent): void;
    'frame:enter'(nodeIndex: number, element: HTMLElement): void;
    'frame:leave'(): void;
    destroy(): void;
};

type Frame<T> = {
    nodeIndex: number;
    value: T;
    name: string;
    color: string;
    x0: number;
    x1: number;
    depth: number;
};

type FrameRow = {
    nodes: number[];
    bounds: number[];
};

const ROW_HEIGHT = 17;
const FRAME_HEIGHT = 16;

const defaultGetName = (frame: FrameData) => frame.name;
const defaultGetValue = (frame: FrameData) => frame.value;
const defaultColorMapper = (frame: FrameData, hue: string | null) =>
    calculateColor(hue || 'warm', generateColorVector(frame.name));

export class FlameChart<T> extends EventEmitter<Events> {
    el: HTMLElement;
    #canvas: HTMLCanvasElement;
    #ctx: CanvasRenderingContext2D;
    #rootLabel: HTMLElement;
    #scrollEl: HTMLElement | null;
    #resizeObserver: ResizeObserver | null = null;
    #events = new AbortController();

    #labels = new SpanLabels();
    #colorMapper: FrameColorGenerator<T> = defaultColorMapper;
    #colorHue: string | null = null;

    #scheduleRenderTimer: number | null = null;
    #childrenSort: ((left: number, right: number) => number) | null = null;
    #lastVisibleFramesEpoch = 0;
    #epoch = 0;

    #width = 0;
    #scrollTop = 0;
    #dpr = 0;
    #minFrameWidth = 2;

    #getValue = defaultGetValue;
    #rows: FrameRow[] = [];
    #walkStack: number[] = [];
    #paintedEnds: number[] = [];
    #ancestorBounds: number[] = [];
    #rootEpoch = -1;
    #rootZoom = -1;

    #hoveredNode = -1;
    #pointer: {
        x: number;
        y: number;
    } | null = null;
    #destroyed = false;

    tree: CallTree<T>;
    nodesMaxDepth = 0;
    nodesDepth: Uint32Array;
    nodesValue: Uint32Array;
    nodesX: Uint32Array;
    children: Uint32Array;
    childrenOffset: Uint32Array;
    childrenComputed: Uint32Array;
    nodesNames: string[];
    nodesColors: string[];

    zoomStart = 0;
    zoomEnd = 1;
    zoomedNode = 0;
    zoomedNodesStack: number[] = [];
    selectedNode = -1;

    constructor(scrollEl: HTMLElement | null = null) {
        super();

        this.#scrollEl = scrollEl;
        this.el = document.createElement('div');
        this.el.className = 'flamechart';

        this.#canvas = document.createElement('canvas');
        this.#canvas.className = 'flamechart__canvas';

        this.#rootLabel = document.createElement('div');
        this.#rootLabel.className = 'flamechart__root-label';

        this.el.append(this.#canvas, this.#rootLabel);
        this.#ctx = this.#canvas.getContext('2d')!;

        const { signal } = this.#events;

        this.#canvas.addEventListener('click', event => {
            const rect = this.#canvas.getBoundingClientRect();
            const node = this.findFrameAt(event.clientX - rect.left, event.clientY - rect.top);

            if (node !== -1) {
                if (event.metaKey) {
                    this.selectFrame(node);
                } else {
                    this.zoomFrame(node, true);
                }

                this.emit('frame:click', node, this.#canvas, event);
            }
        }, { signal });
        this.#canvas.addEventListener('pointermove', event => {
            this.#pointer = { x: event.clientX, y: event.clientY };
            this.#updateHover();
        }, { signal });
        this.#canvas.addEventListener('pointerleave', () => {
            this.#pointer = null;
            this.#updateHover();
        }, { signal });
        scrollEl?.addEventListener('scroll', () => {
            this.#pointer = null;
            this.scheduleRender();
        }, { passive: true, signal });
        document.fonts?.addEventListener('loadingdone', () => {
            this.#labels.clear();
            this.scheduleRender();
        }, { signal });

        if (typeof ResizeObserver === 'function') {
            this.#resizeObserver = new ResizeObserver(() => this.scheduleRender());
            this.#resizeObserver.observe(this.el);

            if (scrollEl) {
                this.#resizeObserver.observe(scrollEl);
            }
        }
    }

    findFrameAt(x: number, y: number): number {
        const offset = y + this.#scrollTop;
        const row = this.#rows[Math.floor(offset / ROW_HEIGHT)];

        if (!row || x < 0 || x >= this.#width || y < 0 || offset % ROW_HEIGHT >= FRAME_HEIGHT) {
            return -1;
        }

        let lower = 0;
        let upper = row.nodes.length;

        while (lower < upper) {
            const middle = (lower + upper) >>> 1;

            if (row.bounds[middle * 2] <= x) {
                lower = middle + 1;
            } else {
                upper = middle;
            }
        }

        const index = lower - 1;

        return index >= 0 && x < row.bounds[index * 2 + 1] ? row.nodes[index] : -1;
    }

    #updateHover() {
        const rect = this.#canvas.getBoundingClientRect();
        const node = this.#pointer
            ? this.findFrameAt(this.#pointer.x - rect.left, this.#pointer.y - rect.top)
            : -1;

        if (node !== this.#hoveredNode) {
            this.#hoveredNode = node;

            if (node === -1) {
                this.emit('frame:leave');
            } else {
                this.emit('frame:enter', node, this.#canvas);
            }

            this.scheduleRender();
        }
    }

    selectFrame(nodeIndex: number) {
        if (this.#destroyed || !this.tree || nodeIndex < 0 || nodeIndex >= this.tree.nodes.length) {
            return this.selectedNode;
        }

        const prevSelected = this.selectedNode;
        const subjectId = this.tree.nodes[nodeIndex];
        const selectedSubjectId = this.tree.nodes[this.selectedNode];

        this.selectedNode = selectedSubjectId !== subjectId && nodeIndex !== 0 ? nodeIndex : -1;
        this.emit('select', this.selectedNode, prevSelected);
        this.scheduleRender();

        return this.selectedNode;
    }

    resetFrameRefs() {
        this.zoomedNode = 0;
        this.zoomedNodesStack = [];
        this.selectedNode = -1;
        this.zoomStart = 0;
        this.zoomEnd = 1;
        this.#rows.length = 0;
        this.#hoveredNode = -1;
        this.#pointer = null;
    }

    setData(tree: CallTree<T>, options: SetDataOptions = {}) {
        if (this.#destroyed) {
            return;
        }

        this.resetFrameRefs();
        this.#labels.clear();
        this.emit('frame:leave');

        const getName = options.name || defaultGetName;
        const getValue = options.value || defaultGetValue;
        const { nodes, parent, subtreeSize } = tree;
        const depth = new Uint32Array(nodes.length);
        const children = new Uint32Array(nodes.length);
        const childrenOffset = new Uint32Array(nodes.length);
        const names = tree.dictionary.map(getName);
        const values = new Uint32Array(nodes.length);
        const positions = new Uint32Array(nodes.length);
        let maxDepth = 0;
        let childrenCursor = 0;

        this.#childrenSort = options.childrenSort === true || options.childrenSort === 'value'
            ? (left, right) => values[right] - values[left]
            : options.childrenSort === 'name'
                ? (left, right) => {
                    const leftName = names[nodes[left]];
                    const rightName = names[nodes[right]];

                    return leftName > rightName ? 1 : leftName < rightName ? -1 : 0;
                }
                : typeof options.childrenSort === 'function'
                    ? options.childrenSort
                    : null;

        for (let index = 0; index < nodes.length; index++) {
            const nodeDepth = depth[parent[index]] + (index !== 0 ? 1 : 0);

            depth[index] = nodeDepth;
            values[index] = getValue(index);
            maxDepth = Math.max(maxDepth, nodeDepth);

            let cursor = index + 1;

            if (cursor < nodes.length && parent[cursor] === index) {
                const end = index + subtreeSize[index];

                while (cursor <= end) {
                    children[childrenCursor++] = cursor;
                    cursor += subtreeSize[cursor] + 1;
                }
            }

            childrenOffset[index] = childrenCursor;
        }

        this.#epoch++;
        this.#getValue = getValue;
        this.nodesMaxDepth = maxDepth;
        this.nodesDepth = depth;
        this.nodesValue = values;
        this.nodesX = positions;
        this.children = children;
        this.childrenOffset = childrenOffset;
        this.childrenComputed = new Uint32Array(nodes.length);
        this.nodesNames = names;
        this.nodesColors = tree.dictionary.map(entry => this.#colorMapper(entry, this.#colorHue));
        this.tree = tree;

        this.scheduleRender();
    }

    resetValues() {
        if (this.#destroyed) {
            return;
        }

        this.#epoch++;
        this.#hoveredNode = -1;
        this.emit('frame:leave');
        this.scheduleRender();
    }

    #computeChildren(nodeIndex: number, nodeX: number) {
        if (this.childrenComputed[nodeIndex] !== 0) {
            return;
        }

        this.childrenComputed[nodeIndex] = 1;

        const end = this.childrenOffset[nodeIndex];
        const start = nodeIndex === 0 ? 0 : this.childrenOffset[nodeIndex - 1];
        const children = this.children.subarray(start, end);

        for (const child of children) {
            this.nodesValue[child] = this.#getValue(child);
        }

        if (children.length > 1 && this.#childrenSort) {
            children.sort(this.#childrenSort);
        }

        for (const child of children) {
            this.nodesX[child] = nodeX;
            nodeX += this.nodesValue[child];
        }
    }

    #syncChildrenComputations() {
        if (this.#lastVisibleFramesEpoch === this.#epoch) {
            return;
        }

        this.#lastVisibleFramesEpoch = this.#epoch;
        this.childrenComputed.fill(0);
        this.#computeChildren(0, 0);

        let rootValue = 0;

        for (const child of this.tree.children(0)) {
            rootValue += this.nodesValue[child];
        }

        this.nodesValue[0] = rootValue;

        if (this.zoomedNode > 0) {
            for (const ancestor of [...this.tree.ancestors(this.zoomedNode)].reverse()) {
                this.#computeChildren(ancestor, this.nodesX[ancestor]);
            }

            this.zoomFrame(this.zoomedNode);
        }
    }

    getVisibleFrames(start = this.zoomStart, end = this.zoomEnd, minScale = 0) {
        if (!this.tree || this.#destroyed) {
            return [];
        }

        this.#syncChildrenComputations();

        const rootWidth = this.nodesValue[0];
        const frames: Frame<T>[] = [];

        if (!(rootWidth > 0)) {
            return frames;
        }

        const minValue = (end - start) * rootWidth * minScale;

        for (let index = 0; index < this.tree.nodes.length; index++) {
            const value = this.nodesValue[index];
            const position = this.nodesX[index];
            const x0 = position / rootWidth;
            const x1 = (position + value) / rootWidth;

            if (x0 < end && x1 > start && value >= minValue) {
                frames.push(this.#frame(index));
                this.#computeChildren(index, position);
            } else {
                index += this.tree.subtreeSize[index];
            }
        }

        return frames;
    }

    #frame(nodeIndex: number): Frame<T> {
        const root = this.nodesValue[0];
        const entry = this.tree.nodes[nodeIndex];

        return {
            nodeIndex,
            value: this.tree.dictionary[entry],
            name: this.nodesNames[entry],
            color: this.nodesColors[entry],
            x0: root > 0 ? this.nodesX[nodeIndex] / root : 0,
            x1: root > 0 ? (this.nodesX[nodeIndex] + this.nodesValue[nodeIndex]) / root : 1,
            depth: this.nodesDepth[nodeIndex]
        };
    }

    #projectFrames(viewHeight: number) {
        const { nodesValue, nodesX, nodesDepth, children, childrenOffset } = this;
        const root = nodesValue[0];
        const start = this.zoomStart * root;
        const end = this.zoomEnd * root;
        const scale = this.#width / (end - start);
        const markerWidth = Math.max(1 / this.#dpr, this.#minFrameWidth);
        const stack = this.#walkStack;
        const paintedEnds = this.#paintedEnds;
        const ancestorBounds = this.#ancestorBounds;
        let maxDepth = 0;

        stack.length = 0;
        paintedEnds.length = 0;
        ancestorBounds.length = 0;

        for (const row of this.#rows) {
            row.nodes.length = 0;
            row.bounds.length = 0;
        }

        if (!(root > 0) || !(end > start)) {
            return maxDepth;
        }

        stack.push(0);

        while (stack.length > 0) {
            const node = stack.pop()!;
            const value = nodesValue[node];
            const position = nodesX[node];

            if (!(value > 0) || position >= end || position + value <= start) {
                continue;
            }

            const depth = nodesDepth[node];
            const x0 = (position - start) * scale;
            const x1 = (position + value - start) * scale;
            const small = value * scale < markerWidth;
            const parentLeft = depth === 0 ? 0 : ancestorBounds[(depth - 1) * 2];
            const parentRight = depth === 0 ? this.#width : ancestorBounds[(depth - 1) * 2 + 1];

            if (x0 >= parentRight || x1 <= parentLeft || small && x1 <= (paintedEnds[depth] || 0)) {
                continue;
            }

            const left = Math.max(
                parentLeft,
                small ? paintedEnds[depth] || 0 : 0,
                small ? Math.floor(x0 * this.#dpr) / this.#dpr : x0
            );
            const right = Math.min(
                parentRight,
                small ? Math.floor(x0 * this.#dpr) / this.#dpr + markerWidth : x1 - 1
            );

            if (right <= left) {
                continue;
            }

            maxDepth = Math.max(maxDepth, depth);
            paintedEnds[depth] = small ? right : Math.min(parentRight, x1);
            ancestorBounds[depth * 2] = left;
            ancestorBounds[depth * 2 + 1] = right;

            const top = depth * ROW_HEIGHT - this.#scrollTop;

            if (top + FRAME_HEIGHT > 0 && top < viewHeight) {
                while (this.#rows.length <= depth) {
                    this.#rows.push({ nodes: [], bounds: [] });
                }

                const row = this.#rows[depth];

                if (!small && row.bounds.length > 0) {
                    const prevEndIndex = row.bounds.length - 1;

                    row.bounds[prevEndIndex] = Math.min(row.bounds[prevEndIndex], left);
                }

                row.nodes.push(node);
                row.bounds.push(left, right);
            }

            if (!small) {
                this.#computeChildren(node, position);

                const from = node === 0 ? 0 : childrenOffset[node - 1];

                for (let cursor = childrenOffset[node] - 1; cursor >= from; cursor--) {
                    stack.push(children[cursor]);
                }
            }
        }

        return maxDepth;
    }

    scheduleRender() {
        if (!this.#destroyed && this.#scheduleRenderTimer === null) {
            this.#scheduleRenderTimer = requestAnimationFrame(() => {
                this.#scheduleRenderTimer = null;
                this.render();
            });
        }
    }

    render() {
        if (this.#destroyed || !this.tree) {
            return;
        }

        this.#syncChildrenComputations();
        this.#width = this.el.getBoundingClientRect().width;

        if (!(this.#width > 0)) {
            return;
        }

        const dpr = window.devicePixelRatio || 1;

        this.#scrollTop = this.#scrollEl?.scrollTop || 0;

        const viewportHeight = this.#scrollEl?.clientHeight || 300;
        const previousDpr = this.#dpr;

        this.#dpr = dpr;

        const maxDepth = this.#projectFrames(viewportHeight);
        const height = Math.max(maxDepth + 1, 10) * ROW_HEIGHT + 2;

        this.el.style.height = `${height}px`;

        const scrollTop = Math.min(this.#scrollTop, Math.max(0, height - viewportHeight));

        if (scrollTop !== this.#scrollTop) {
            this.#scrollTop = scrollTop;

            if (this.#scrollEl) {
                this.#scrollEl.scrollTop = scrollTop;
            }

            this.#projectFrames(viewportHeight);
        }

        const viewHeight = Math.min(height, viewportHeight);
        const widthPixels = Math.ceil(this.#width * dpr);
        const heightPixels = Math.ceil(viewHeight * dpr);

        if (this.#canvas.width !== widthPixels || this.#canvas.height !== heightPixels || previousDpr !== dpr) {
            this.#canvas.width = widthPixels;
            this.#canvas.height = heightPixels;
            this.#dpr = dpr;
            this.#ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        this.#canvas.style.width = `${this.#width}px`;
        this.#canvas.style.height = `${viewHeight}px`;
        this.#canvas.style.top = `${this.#scrollTop}px`;

        const ctx = this.#ctx;
        const style = getComputedStyle(this.el);
        const selectedId = this.selectedNode >= 0 ? this.tree.nodes[this.selectedNode] : -1;

        ctx.clearRect(0, 0, this.#width, viewHeight);
        ctx.font = SPAN_LABEL_FONT;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';

        for (let depth = 0; depth < this.#rows.length; depth++) {
            const row = this.#rows[depth];
            const top = depth * ROW_HEIGHT - this.#scrollTop;

            for (let index = 0; index < row.nodes.length; index++) {
                const node = row.nodes[index];
                const entry = this.tree.nodes[node];
                const left = row.bounds[index * 2];
                const width = row.bounds[index * 2 + 1] - left;
                const similar = node !== 0 && entry === selectedId;

                ctx.globalAlpha = node < this.zoomedNode ? 0.65 : 1;
                ctx.fillStyle = similar
                    ? '#d6bb2d'
                    : `rgba(${this.nodesColors[entry]}, ${node === this.#hoveredNode ? 0.5 : 0.4})`;
                ctx.fillRect(left, top, width, FRAME_HEIGHT);

                if (node === this.zoomedNode && node !== 0) {
                    ctx.strokeStyle = '#d6bb2d';
                    ctx.lineWidth = 1.5;
                    ctx.strokeRect(left + 0.75, top + 0.75, Math.max(0, width - 1.5), FRAME_HEIGHT - 1.5);
                }

                if (node !== 0) {
                    const text = this.#labels.fit(ctx, this.nodesNames[entry] || '', width - 6);

                    if (text) {
                        ctx.save();
                        ctx.beginPath();
                        ctx.rect(left, top, width, FRAME_HEIGHT);
                        ctx.clip();
                        ctx.fillStyle = similar ? '#000' : style.color;
                        ctx.fillText(text, left + 3, top + FRAME_HEIGHT / 2);
                        ctx.restore();
                    }
                }
            }
        }

        ctx.globalAlpha = 1;
        this.#updateHover();

        if (this.#rootEpoch !== this.#epoch || this.#rootZoom !== this.zoomedNode) {
            this.#rootEpoch = this.#epoch;
            this.#rootZoom = this.zoomedNode;
            this.emit('render', this.#rootLabel, this.#frame(0), this.nodesValue[0]);
        }
    }

    zoomFrame(nodeIndex = 0, toggle = false) {
        if (this.#destroyed || !this.tree || nodeIndex < 0 || nodeIndex >= this.tree.nodes.length) {
            return;
        }

        const prevZoomedNode = this.zoomedNode;
        const prevZoomStart = this.zoomStart;
        const prevZoomEnd = this.zoomEnd;

        if (this.zoomedNode !== nodeIndex && nodeIndex !== 0) {
            if (this.zoomedNode !== 0) {
                this.zoomedNodesStack = this.zoomedNodesStack.filter(index => this.nodesDepth[index] < this.nodesDepth[nodeIndex]);

                if (this.nodesDepth[this.zoomedNode] < this.nodesDepth[nodeIndex]) {
                    this.zoomedNodesStack.push(this.zoomedNode);
                }
            }

            this.zoomedNode = nodeIndex;
        } else if (this.zoomedNode === nodeIndex) {
            if (toggle) {
                this.zoomedNode = this.zoomedNodesStack.pop() || 0;
            } else {
                while (this.zoomedNode !== 0 && this.nodesValue[this.zoomedNode] === 0) {
                    this.zoomedNode = this.zoomedNodesStack.pop() || 0;
                }
            }
        } else {
            this.zoomedNode = 0;
            this.zoomedNodesStack = [];
        }

        const root = this.nodesValue[0];

        this.zoomStart = root > 0 ? this.nodesX[this.zoomedNode] / root : 0;
        this.zoomEnd = root > 0 ? this.zoomStart + this.nodesValue[this.zoomedNode] / root : 1;

        if (this.zoomEnd <= this.zoomStart) {
            this.zoomedNode = 0;
            this.zoomStart = 0;
            this.zoomEnd = 1;
        }

        if (prevZoomedNode !== this.zoomedNode || prevZoomStart !== this.zoomStart || prevZoomEnd !== this.zoomEnd) {
            this.emit('zoom', this.zoomedNode, this.zoomStart, this.zoomEnd);
        }

        this.scheduleRender();
    }

    resetZoom() {
        this.zoomFrame(0);
    }

    get colorHue() {
        return this.#colorHue;
    }
    set colorHue(hue: string | null) {
        this.#colorHue = hue;

        if (this.tree) {
            this.nodesColors = this.tree.dictionary.map(entry => this.#colorMapper(entry, hue));
        }

        this.scheduleRender();
    }

    get colorMapper() {
        return this.#colorMapper;
    }
    set colorMapper(mapper: FrameColorGenerator<T>) {
        this.#colorMapper = mapper;

        if (this.tree) {
            this.nodesColors = this.tree.dictionary.map(entry => mapper(entry, this.#colorHue));
        }

        this.scheduleRender();
    }

    get minFrameWidth() {
        return this.#minFrameWidth;
    }
    set minFrameWidth(width: number) {
        this.#minFrameWidth = width;
        this.scheduleRender();
    }

    destroy() {
        if (this.#destroyed) {
            return;
        }

        this.#destroyed = true;
        this.emit('destroy');

        if (this.#scheduleRenderTimer !== null) {
            cancelAnimationFrame(this.#scheduleRenderTimer);
        }

        this.#scheduleRenderTimer = null;
        this.#events.abort();
        this.#labels.clear();
        this.resetFrameRefs();
        this.#resizeObserver?.disconnect();
        this.#resizeObserver = null;
        this.el.remove();
        this.el = null as unknown as HTMLElement;
    }
}
