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
    opacity: number[];
    layer: number[];
};

type TransitionRow = {
    nodes: number[];
    from: number[];
    to: number[];
    parents: number[];
    layer: number[];
};

type ZoomMode = 'select' | 'continuous';

const ROW_HEIGHT = 17;
const FRAME_GAP = 1;
const FRAME_HEIGHT = ROW_HEIGHT - FRAME_GAP;
const ZOOM_TIME_CONSTANT = 65;
const FRAME_REVEAL_DISTANCE = 1;
const FRAME_REVEAL_DELAY_FACTOR = 0.6;
const FRAME_FADE_IN_DURATION = 250;
const FRAME_FADE_OUT_TIME_CONSTANT = 15;

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
    #viewportHeight = 0;
    #scrollTop = 0;
    #dpr = 0;
    #minFrameWidth = 2;
    #projectionDirty = true;

    #viewStart = 0;
    #viewEnd = 1;
    #viewReady = false;
    #zoomTime: number | null = null;
    #reducedMotion: MediaQueryList | null = null;
    #zoomMode: ZoomMode = 'select';
    #transitionPending = false;
    #transitionProgress = 1;
    #transitionElapsed = 0;
    #transitionMotionTime = 0;
    #transitionDepth = 0;
    #transitionDelta = { bounds: 0, arrival: 0, departure: 0, common: 0 };
    #transitionScrollTop = 0;
    #maxDepth = 0;
    #targetRows: FrameRow[] = [];
    #transitionRows: TransitionRow[] = [];

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

        // Later click observers run first and see the state before the default action.
        this.on('frame:click', (node, _element, event) => {
            if (event.metaKey) {
                this.selectFrame(node);
            } else {
                this.zoomFrame(node, true);
            }
        });

        const { signal } = this.#events;

        this.#reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
        this.#reducedMotion?.addEventListener('change', () => this.scheduleRender(), { signal });

        this.#canvas.addEventListener('click', event => {
            const rect = this.#canvas.getBoundingClientRect();
            const node = this.findFrameAt(event.clientX - rect.left, event.clientY - rect.top);

            if (node !== -1) {
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

        if (!row || x < 0 || x >= this.#width || y < 0) {
            return -1;
        }

        if (this.#transitionProgress < 1) {
            const depth = Math.floor(offset / ROW_HEIGHT);

            if (depth >= Math.ceil((this.#scrollTop + this.#viewportHeight) / ROW_HEIGHT)) {
                this.#projectTransitionRows(0, depth + 1, this.#transitionScrollTop);
            }

            for (const padding of [0, FRAME_GAP]) {
                for (let layer = 2; layer >= 0; layer--) {
                    for (let index = row.nodes.length - 1; index >= 0; index--) {
                        const left = row.bounds[index * 2];
                        const right = row.bounds[index * 2 + 1];

                        if (row.layer[index] === layer && row.opacity[index] > 0.01 && right > left &&
                            x >= left && x < right + padding) {
                            return row.nodes[index];
                        }
                    }
                }
            }

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

        return index >= 0 && row.bounds[index * 2 + 1] > row.bounds[index * 2] &&
            x < row.bounds[index * 2 + 1] + FRAME_GAP ? row.nodes[index] : -1;
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
        this.#viewReady = false;
        this.#projectionDirty = true;
        this.#zoomTime = null;
        this.#transitionPending = false;
        this.#transitionProgress = 1;
        this.#transitionRows.length = 0;
        this.#targetRows.length = 0;
        this.#rows.length = 0;
        this.#hoveredNode = -1;
        this.#pointer = null;
    }

    setData(tree: CallTree<T>, options: SetDataOptions = {}) {
        if (this.#destroyed) {
            return;
        }

        // Only a different tree invalidates node identities and navigation history.
        if (tree !== this.tree) {
            this.resetFrameRefs();
        }

        this.#hoveredNode = -1;
        this.#labels.clear();
        this.emit('frame:leave');

        options ||= {};

        const getName = typeof options.name === 'function' ? options.name : defaultGetName;
        const getValue = typeof options.value === 'function' ? options.value : defaultGetValue;
        const { nodes, parent, subtreeSize } = tree;
        const depth = new Uint32Array(nodes.length);
        const children = new Uint32Array(nodes.length);
        const childrenOffset = new Uint32Array(nodes.length);
        const names = tree.dictionary.map(getName);
        const values = new Uint32Array(nodes.length);
        const positions = new Uint32Array(nodes.length);
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
        this.#projectionDirty = true;

        if (this.#viewReady) {
            this.#zoomMode = 'select';
            this.#transitionPending = true;
            // Retargeting must preserve elapsed time since the last animation frame.
            this.#zoomTime ??= performance.now();
        }

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

    #projectFrames(viewHeight: number, rows = this.#rows, viewStart = this.#viewStart, viewEnd = this.#viewEnd) {
        const { nodesValue, nodesX, nodesDepth, children, childrenOffset } = this;
        const root = nodesValue[0];
        const start = viewStart * root;
        const end = viewEnd * root;
        const scale = this.#width / (end - start);
        const markerWidth = Math.max(1 / this.#dpr, this.#minFrameWidth);
        const stack = this.#walkStack;
        const paintedEnds = this.#paintedEnds;
        const ancestorBounds = this.#ancestorBounds;
        let maxDepth = 0;

        stack.length = 0;
        paintedEnds.length = 0;
        ancestorBounds.length = 0;

        for (const row of rows) {
            row.nodes.length = 0;
            row.bounds.length = 0;
            row.opacity.length = 0;
            row.layer.length = 0;
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
                small ? Math.floor(x0 * this.#dpr) / this.#dpr + markerWidth : x1 - FRAME_GAP
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
                while (rows.length <= depth) {
                    rows.push({ nodes: [], bounds: [], opacity: [], layer: [] });
                }

                const row = rows[depth];

                if (!small && row.bounds.length > 0) {
                    const prevEndIndex = row.bounds.length - 1;

                    row.bounds[prevEndIndex] = Math.min(row.bounds[prevEndIndex], left);
                }

                row.nodes.push(node);
                row.bounds.push(left, right);
                row.opacity.push(1);
                row.layer.push(2);
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

    #prepareTransition(viewHeight: number, widthScale: number) {
        // Retargeting reads the last frame, including rows whose interpolation was deferred offscreen.
        // Restored rows retain transition order, so source indices also address previous origins.
        if (this.#transitionProgress < 1) {
            this.#projectTransitionRows(0, this.#transitionRows.length, this.#transitionScrollTop);
        }

        const continuing = !this.#transitionPending && this.#transitionProgress < 1;
        const depth = this.#projectFrames(viewHeight, this.#targetRows, this.zoomStart, this.zoomEnd);
        const rowCount = Math.max(this.#rows.length, this.#targetRows.length);
        const sourcePositions = new Map<number, number>();
        const targetPositions = new Map<number, number>();
        let parentPositions = new Map<number, number>();
        let currentPositions = new Map<number, number>();
        let fromBuffer: number[] | null = continuing ? [] : null;
        const delta = this.#transitionDelta;

        delta.bounds = 0;
        delta.arrival = 0;
        delta.departure = 0;
        delta.common = 0;

        this.#transitionDepth = Math.max(this.#maxDepth, depth);

        if (!continuing) {
            this.#transitionProgress = 0;
            this.#transitionElapsed = 0;
        }

        this.#transitionPending = false;

        for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
            const source = this.#rows[rowIndex] ||= { nodes: [], bounds: [], opacity: [], layer: [] };
            const target = this.#targetRows[rowIndex];
            const row = this.#transitionRows[rowIndex] ||= { nodes: [], from: [], to: [], parents: [], layer: [] };

            // An empty restored source has no transition entries; retain its depth slot for parent links.
            if (!source.nodes.length && !target?.nodes.length) {
                parentPositions.clear();
                continue;
            }

            const previousFrom = continuing ? row.from : null;

            // Read each row's old origins before recycling its buffer for the next row.
            if (previousFrom) {
                row.from = fromBuffer!;
                fromBuffer = previousFrom;
            }

            sourcePositions.clear();
            targetPositions.clear();
            currentPositions.clear();

            row.nodes.length = 0;
            row.from.length = 0;
            row.to.length = 0;
            row.parents.length = 0;
            row.layer.length = 0;

            if (target) {
                for (let index = 0; index < target.nodes.length; index++) {
                    const node = target.nodes[index];

                    targetPositions.set(node, index);
                    row.nodes.push(node);
                }
            }

            for (let index = 0; index < source.nodes.length; index++) {
                const node = source.nodes[index];
                const inTarget = targetPositions.has(node);

                // A still-targeted node is a source even before its first visible paint.
                if (inTarget ||
                    source.opacity[index] > 0.001 && source.bounds[index * 2 + 1] > source.bounds[index * 2]) {
                    sourcePositions.set(node, index);

                    if (!inTarget) {
                        row.nodes.push(node);
                    }
                }
            }

            if (row.nodes.length > 1) {
                row.nodes.sort((left, right) => this.nodesX[left] - this.nodesX[right] || left - right);
            }

            for (let index = 0; index < row.nodes.length; index++) {
                const node = row.nodes[index];
                const sourceIndex = sourcePositions.get(node);
                const targetIndex = targetPositions.get(node);
                const previousIndex = continuing ? sourceIndex : undefined;
                const left = previousIndex !== undefined
                    ? previousFrom![previousIndex * 3] * widthScale
                    : sourceIndex !== undefined
                        ? source.bounds[sourceIndex * 2] * widthScale
                        : target.bounds[targetIndex! * 2];
                const right = previousIndex !== undefined
                    ? previousFrom![previousIndex * 3 + 1] * widthScale
                    : sourceIndex !== undefined
                        ? source.bounds[sourceIndex * 2 + 1] * widthScale
                        : target.bounds[targetIndex! * 2 + 1];
                const opacity = previousIndex !== undefined
                    ? previousFrom![previousIndex * 3 + 2]
                    : sourceIndex !== undefined
                        ? source.opacity[sourceIndex]
                        : continuing ? 1 : 0;
                const targetLeft = targetIndex !== undefined ? target.bounds[targetIndex * 2] : left;
                const targetRight = targetIndex !== undefined ? target.bounds[targetIndex * 2 + 1] : right;
                const targetOpacity = targetIndex !== undefined ? 1 : 0;
                const layer = targetOpacity === 0
                    ? 0
                    : previousIndex !== undefined
                        ? source.layer[sourceIndex!] === 1 ? 1 : 2
                        : sourceIndex !== undefined || continuing ? 2 : 1;
                const opacityMode = layer === 0 ? 'departure' : layer === 1 ? 'arrival' : 'common';

                // Shared progress curves let unclipped error maxima include offscreen nodes without a per-frame scan.
                delta.bounds = Math.max(delta.bounds, Math.abs(targetLeft - left), Math.abs(targetRight - right));
                delta[opacityMode] = Math.max(delta[opacityMode], Math.abs(targetOpacity - opacity));

                row.from.push(left, right, opacity);
                row.to.push(targetLeft, targetRight, targetOpacity);
                row.parents.push(parentPositions.get(this.tree.parent[node]) ?? -1);
                row.layer.push(layer);
                currentPositions.set(node, index);
            }

            // Only the preceding depth's positions survive into the next row.
            const previousParentPositions = parentPositions;

            parentPositions = currentPositions;
            currentPositions = previousParentPositions;
        }

        this.#transitionRows.length = rowCount;

        if (!continuing || widthScale !== 1) {
            this.#transitionMotionTime = ZOOM_TIME_CONSTANT * Math.log(Math.max(1, delta.bounds * this.#dpr / 0.25));
        }
    }

    #projectTransitionRows(firstDepth: number, endDepth: number, scrollTop: number) {
        const geometryProgress = this.#transitionElapsed >= this.#transitionMotionTime ? 1 : this.#transitionProgress;
        const arrivalDelay = Math.max(0,
            this.#transitionMotionTime - ZOOM_TIME_CONSTANT * Math.log(FRAME_REVEAL_DISTANCE / 0.25)
        ) * FRAME_REVEAL_DELAY_FACTOR;
        const arrivalTime = Math.min(1, Math.max(0, this.#transitionElapsed - arrivalDelay) / FRAME_FADE_IN_DURATION);
        const arrivalProgress = arrivalTime * arrivalTime * (3 - 2 * arrivalTime);
        const departureProgress = -Math.expm1(-this.#transitionElapsed / FRAME_FADE_OUT_TIME_CONSTANT);
        const delta = this.#transitionDelta;
        const error = Math.max(
            delta.bounds * (1 - geometryProgress) * this.#dpr,
            delta.arrival * (1 - arrivalProgress) * 255,
            delta.departure * (1 - departureProgress) * 255,
            delta.common * (1 - this.#transitionProgress) * 255
        );

        for (let depth = firstDepth; depth < endDepth; depth++) {
            const transition = this.#transitionRows[depth];
            const { from, to } = transition;
            const row = this.#rows[depth];
            const parentRow = depth > 0 && (depth - 1) * ROW_HEIGHT + FRAME_HEIGHT > scrollTop
                ? this.#rows[depth - 1]
                : null;

            row.nodes.length = 0;
            row.bounds.length = 0;
            row.opacity.length = 0;
            row.layer.length = 0;

            for (let index = 0; index < transition.nodes.length; index++) {
                const offset = index * 3;
                const layer = transition.layer[index];
                const opacityProgress = layer === 0
                    ? departureProgress
                    : layer === 1
                        ? arrivalProgress
                        : this.#transitionProgress;
                let left = from[offset] + (to[offset] - from[offset]) * geometryProgress;
                let right = from[offset + 1] + (to[offset + 1] - from[offset + 1]) * geometryProgress;
                let opacity = from[offset + 2] + (to[offset + 2] - from[offset + 2]) * opacityProgress;

                if (parentRow) {
                    const parent = transition.parents[index];

                    if (parent === -1) {
                        opacity = 0;
                    } else {
                        left = Math.max(left, parentRow.bounds[parent * 2]);
                        right = Math.min(right, parentRow.bounds[parent * 2 + 1]);
                        opacity = Math.min(opacity, parentRow.opacity[parent]);
                    }
                }

                row.nodes.push(transition.nodes[index]);
                row.bounds.push(left, Math.max(left, right));
                row.opacity.push(opacity);
                row.layer.push(layer);
            }
        }

        return error;
    }

    #advanceTransition(time: number) {
        const elapsed = Math.max(0, time - (this.#zoomTime ?? time));

        this.#transitionProgress += (1 - this.#transitionProgress) * -Math.expm1(-elapsed / ZOOM_TIME_CONSTANT);
        this.#transitionElapsed += elapsed;
        this.#transitionScrollTop = this.#scrollTop;
        this.#zoomTime = time;

        const firstDepth = Math.max(0, Math.floor(this.#scrollTop / ROW_HEIGHT));
        const endDepth = Math.min(this.#transitionRows.length, Math.ceil((this.#scrollTop + this.#viewportHeight) / ROW_HEIGHT));
        const error = this.#projectTransitionRows(firstDepth, endDepth, this.#scrollTop);

        if (error <= 0.25) {
            this.#transitionProgress = 1;
            this.#zoomTime = null;

            return false;
        }

        return true;
    }

    #projectView(viewHeight: number, time: number, layoutChanged: boolean, widthScale: number) {
        layoutChanged ||= this.#projectionDirty;

        // Paint-only updates reuse settled geometry; active motion still advances every frame.
        if (this.#viewReady && !layoutChanged && !this.#transitionPending && this.#transitionProgress === 1 &&
            this.#viewStart === this.zoomStart && this.#viewEnd === this.zoomEnd) {
            return false;
        }

        this.#projectionDirty = false;

        if (this.#zoomMode === 'select' && this.#viewReady && !this.#reducedMotion?.matches) {
            if (this.#transitionPending || this.#transitionProgress < 1 && layoutChanged) {
                this.#prepareTransition(viewHeight, widthScale);
            }

            this.#viewStart = this.zoomStart;
            this.#viewEnd = this.zoomEnd;

            if (this.#transitionProgress < 1 && this.#advanceTransition(time)) {
                this.#maxDepth = this.#transitionDepth;

                return true;
            }
        }

        this.#transitionPending = false;
        this.#transitionProgress = 1;
        this.#transitionRows.length = 0;

        const moving = this.#advanceViewport(time);

        this.#maxDepth = this.#projectFrames(viewHeight);

        return moving;
    }

    #advanceViewport(time: number) {
        if (!this.#viewReady || this.#reducedMotion?.matches) {
            this.#viewStart = this.zoomStart;
            this.#viewEnd = this.zoomEnd;
            this.#viewReady = true;
            this.#zoomTime = null;

            return false;
        }

        if (this.#viewStart === this.zoomStart && this.#viewEnd === this.zoomEnd) {
            this.#zoomTime = null;

            return false;
        }

        const elapsed = Math.max(0, time - (this.#zoomTime ?? time));
        const amount = -Math.expm1(-elapsed / ZOOM_TIME_CONSTANT);
        const prevStart = this.#viewStart;
        const prevEnd = this.#viewEnd;

        this.#viewStart += (this.zoomStart - this.#viewStart) * amount;
        this.#viewEnd += (this.zoomEnd - this.#viewEnd) * amount;
        this.#zoomTime = time;

        const error = Math.max(
            Math.abs(this.zoomStart - this.#viewStart),
            Math.abs(this.zoomEnd - this.#viewEnd)
        ) * this.#width * this.#dpr / (this.zoomEnd - this.zoomStart);

        if (error <= 0.25 || elapsed > 0 && this.#viewStart === prevStart && this.#viewEnd === prevEnd) {
            this.#viewStart = this.zoomStart;
            this.#viewEnd = this.zoomEnd;
            this.#zoomTime = null;

            return false;
        }

        return true;
    }

    scheduleRender() {
        if (!this.#destroyed && this.#scheduleRenderTimer === null) {
            this.#scheduleRenderTimer = requestAnimationFrame(time => {
                this.#scheduleRenderTimer = null;
                this.render(time);
            });
        }
    }

    render(time = performance.now()) {
        if (this.#destroyed || !this.tree) {
            return;
        }

        this.#syncChildrenComputations();

        const previousWidth = this.#width;
        const previousScrollTop = this.#scrollTop;

        this.#width = this.el.getBoundingClientRect().width;

        if (!(this.#width > 0)) {
            return;
        }

        const dpr = window.devicePixelRatio || 1;

        this.#scrollTop = this.#scrollEl?.scrollTop || 0;

        const viewportHeight = this.#scrollEl?.clientHeight || 300;
        const previousViewportHeight = this.#viewportHeight;
        const previousDpr = this.#dpr;

        this.#viewportHeight = viewportHeight;
        this.#dpr = dpr;

        const layoutChanged = previousWidth !== this.#width || previousViewportHeight !== viewportHeight ||
            previousScrollTop !== this.#scrollTop || previousDpr !== dpr;
        let moving = this.#projectView(viewportHeight, time, layoutChanged, previousWidth > 0 ? this.#width / previousWidth : 1);
        const height = Math.max(this.#maxDepth + 1, 10) * ROW_HEIGHT + 2;

        this.el.style.height = `${height}px`;

        const scrollTop = Math.min(this.#scrollTop, Math.max(0, height - viewportHeight));

        if (scrollTop !== this.#scrollTop) {
            this.#scrollTop = scrollTop;

            if (this.#scrollEl) {
                this.#scrollEl.scrollTop = scrollTop;
            }

            moving = this.#projectView(viewportHeight, time, true, 1);
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
        this.#rootLabel.style.opacity = this.zoomedNode > 0 ? '0.65' : '1';

        const ctx = this.#ctx;
        const style = getComputedStyle(this.el);
        const background = style.getPropertyValue('--discovery-background-color').trim() || '#242424';
        const selectedId = this.selectedNode >= 0 ? this.tree.nodes[this.selectedNode] : -1;
        const firstDepth = Math.max(0, Math.floor(this.#scrollTop / ROW_HEIGHT));
        const endDepth = Math.min(this.#rows.length, Math.ceil((this.#scrollTop + viewHeight) / ROW_HEIGHT));
        // Settled rows contain only common frames; the other layers are needed during transitions.
        const firstLayer = this.#transitionProgress < 1 ? 0 : 2;

        ctx.clearRect(0, 0, this.#width, viewHeight);
        ctx.font = SPAN_LABEL_FONT;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';

        // Keep offscreen transition origins for reverse scrolling, but do not paint their rows.
        for (let depth = firstDepth; depth < endDepth; depth++) {
            const row = this.#rows[depth];
            const top = depth * ROW_HEIGHT - this.#scrollTop;

            if (top + FRAME_HEIGHT <= 0) {
                continue;
            }

            for (let layer = firstLayer; layer < 3; layer++) {
                for (let index = 0; index < row.nodes.length; index++) {
                    if (row.layer[index] !== layer || row.opacity[index] <= 0 || row.bounds[index * 2 + 1] <= row.bounds[index * 2]) {
                        continue;
                    }

                    const node = row.nodes[index];
                    const entry = this.tree.nodes[node];
                    const left = row.bounds[index * 2];
                    const width = row.bounds[index * 2 + 1] - left;
                    const similar = node !== 0 && entry === selectedId;
                    const ancestor = node < this.zoomedNode && node + this.tree.subtreeSize[node] >= this.zoomedNode;

                    ctx.globalAlpha = row.opacity[index] * (ancestor ? 0.65 : 1);
                    ctx.fillStyle = similar
                        ? '#d6bb2d'
                        : `color-mix(in srgb, rgb(${this.nodesColors[entry]}) ${node === this.#hoveredNode ? 30 : 40}%, ${background})`;
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
        }

        ctx.globalAlpha = 1;
        this.#updateHover();

        // Root content follows metadata and zoom, not intermediate animation geometry.
        if (this.#rootEpoch !== this.#epoch || this.#rootZoom !== this.zoomedNode) {
            this.#rootEpoch = this.#epoch;
            this.#rootZoom = this.zoomedNode;
            this.emit('render', this.#rootLabel, this.#frame(0), this.nodesValue[0]);
        }

        if (moving) {
            this.scheduleRender();
        }
    }

    zoomFrame(nodeIndex = 0, toggle = false, mode: ZoomMode = 'select') {
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
            this.#zoomMode = mode;
            this.#transitionPending = mode === 'select';
            this.#zoomTime ??= performance.now();
            this.emit('zoom', this.zoomedNode, this.zoomStart, this.zoomEnd);
        }

        this.scheduleRender();
    }

    resetZoom(mode: ZoomMode = this.#zoomMode) {
        this.zoomFrame(0, false, mode);
    }

    get colorHue() {
        return this.#colorHue;
    }
    set colorHue(hue: string | null) {
        this.#colorHue = hue;

        if (this.tree) {
            this.nodesColors = this.tree.dictionary.map(entry => this.#colorMapper(entry, hue));
            this.#rootEpoch = -1;
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
            this.#rootEpoch = -1;
        }

        this.scheduleRender();
    }

    get minFrameWidth() {
        return this.#minFrameWidth;
    }
    set minFrameWidth(width: number) {
        if (this.#minFrameWidth === width) {
            return;
        }

        this.#minFrameWidth = width;
        this.#projectionDirty = true;
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
