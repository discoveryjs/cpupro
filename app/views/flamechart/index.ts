import { generateColorVector, calculateColor } from './color-utils';
import { EventEmitter } from './event-emmiter';

type FrameElement = HTMLElement;
type FrameData = any;
type FrameColorGenerator = (frame: Frame, colorHue: string | null) => string;
type SetDataOptions = {
    name?(data: FrameData): string;
    value?(data: FrameData): number;
    offset?(data: FrameData, parentData: FrameData): number;
    children?(data: FrameData): FrameData[] | null | undefined;
    childrenSort?: true | ((a: FrameData, b: FrameData) => number);
}
type Events = {
    select(frame: Frame | null, prevFrame: Frame | null): void;
    zoom(frame: Frame | null): void;
    'frame:click'(frame: Frame, element: FrameElement): void;
    'frame:enter'(frame: Frame, element: FrameElement): void;
    'frame:leave'(): void;
    destroy(): void;
}

class Frame {
    parent: Frame | null;
    next: Frame | null;
    nextSibling: Frame | null;
    data: FrameData;
    name: string;
    value: number;
    depth: number;
    x0: number;
    x1: number;
    fade: boolean;
    selected: boolean;

    constructor(parent: Frame | null, data: FrameData) {
        this.parent = parent;
        this.next = null;
        this.nextSibling = null;
        this.data = data;
        this.name = '';
        this.value = 0;
        this.depth = 0;
        this.x0 = 0;
        this.x1 = 1;
        this.fade = false;
        this.selected = false;
    }
}

const defaultGetName: Exclude<SetDataOptions['name'], undefined> = (frameData: FrameData) => frameData.name;
const defaultGetValue: Exclude<SetDataOptions['value'], undefined> = (frameData: FrameData) => frameData.value;
const defaultGetChildren: Exclude<SetDataOptions['children'], undefined> = (frameData: FrameData) => frameData.children;

function ensureFunction<T, U>(value: T, fallback: U) {
    return typeof value === 'function' ? value : fallback;
}

// let labelHandler = function(frame: Frame) {
//     return `${frame.name} (${(100 * frame.value / rootFrameNode.value).toFixed(2)}%, ${frame.value} ms)`;
// };

function defaultColorMapper(frame: Frame, colorHue: string | null = null) {
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

export class FlameChart extends EventEmitter<Events> {
    el: HTMLElement;
    #resizeObserver: ResizeObserver | null = null;

    #colorMapper: FrameColorGenerator = defaultColorMapper;
    #colorHue: string | null = null;
    #scheduleRenderTimer: Promise<void> | null = null;

    #width = 0; // graph width
    #minFrameWidth = 2;
    zoomStart = 0;
    zoomEnd = 1;

    selectedFrame: Frame | null = null;
    selectedFramesStack: Frame[] = [];
    rootFrame: Frame | null = null;
    fadedFrames = new Set<Frame>();
    frameEls = new Map<Frame, HTMLElement>();
    frameByEl = new WeakMap();

    constructor() {
        super();

        // create chart element
        this.el = this.createElement(this);
        this.on('frame:click', (frame) => {
            this.selectFrame(frame);
            this.zoomFrame(this.selectedFrame);
        });
    }

    createElement(chart: FlameChart) {
        const chartEl = document.createElement('div');

        chartEl.className = 'flamechart';
        chartEl.addEventListener('click', event => {
            const result = chart.findFrameByEl(event.target as Node);

            if (result !== null) {
                chart.emit('frame:click', result.frame, result.element as FrameElement);
            }
        }, true);
        chartEl.addEventListener('pointerenter', event => {
            const result = chart.findFrameByEl(event.target as Node);

            if (result !== null) {
                chart.emit('frame:enter', result.frame, result.element as FrameElement);
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
                        frame: this.frameByEl.get(cursor)
                    };
                }

                cursor = cursor.parentNode;
            }
        }

        return null;
    }

    selectFrame(frame: Frame) {
        const prevSelected = this.selectedFrame;

        if (this.selectedFrame !== frame && frame !== this.rootFrame) {
            if (this.selectedFrame !== null) {
                this.selectedFrame.selected = false;

                this.selectedFramesStack = this.selectedFramesStack
                    .filter(item => item.depth < frame.depth);

                if (this.selectedFrame.depth < frame.depth) {
                    this.selectedFramesStack.push(this.selectedFrame);
                }
            }

            this.selectedFrame = frame;
            this.selectedFrame.selected = true;
        } else if (this.selectedFrame === frame) {
            this.selectedFrame.selected = false;
            this.selectedFrame = null;

            if (this.selectedFramesStack.length > 0) {
                this.selectedFrame = this.selectedFramesStack.pop() as Frame;
                this.selectedFrame.selected = true;
            }
        } else if (this.selectedFrame !== null) {
            this.selectedFrame.selected = false;
            this.selectedFrame = null;
            this.selectedFramesStack = [];
        }

        this.emit('select', this.selectedFrame, prevSelected);
        this.scheduleRender();

        return this.selectedFrame;
    }

    resetFrameRefs() {
        this.selectedFrame = null;
        this.selectedFramesStack = [];
        this.rootFrame = null;
        this.fadedFrames.clear();
        this.frameByEl = new WeakMap();
        this.frameEls.clear();
    }

    setData(rootData: FrameData, options?: SetDataOptions) {
        this.resetFrameRefs();

        options = options || {};

        const getName = ensureFunction(options.name, defaultGetName);
        const getValue = ensureFunction(options.value, defaultGetValue);
        const getOffset = ensureFunction(options.offset, (() => x0) as (child: FrameData, parent: FrameData) => number);
        const getChildren = ensureFunction(options.children, defaultGetChildren);
        const childrenSort = ensureFunction(options.childrenSort !== true ? options.childrenSort : (a: FrameData, b: FrameData) => {
            const nameA = getName(a);
            const nameB = getName(b);

            return nameA > nameB ? 1 : nameA < nameB ? -1 : 0;
        }, false);

        // creating a precomputed hierarchical structure
        let parent: Frame | null = this.rootFrame = new Frame(null, rootData);
        let x0 = 0;
        parent.name = getName(rootData);
        parent.value = getValue(rootData);

        while (parent !== null) {
            let children = getChildren(parent.data);

            if (Array.isArray(children)) {
                if (childrenSort !== false) {
                    // use slice() to avoid data mutation
                    children = children.slice().sort(childrenSort);
                }

                const parentNext: Frame | null = parent.next;
                let prev: Frame | null = null;

                x0 = parent.x0;

                for (const childData of children) {
                    const child = new Frame(parent, childData);

                    child.depth = parent.depth + 1;
                    child.name = getName(childData);
                    child.value = getValue(childData);
                    child.x0 = x0 = getOffset(childData, parent.data);
                    child.x1 = x0 += child.value / this.rootFrame.value;

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

        this.scheduleRender();
    }

    getVisibleFrames(
        root = this.rootFrame,
        start = this.zoomStart,
        end = this.zoomEnd,
        minScale = 0
    ) {
        if (root === null) {
            return [];
        }

        const minValue = (end - start) * root.value * minScale;
        const nodeList: Frame[] = [];
        let node: Frame | null = root;

        while (node !== null) {
            if (node.x0 < end && node.x1 > start && node.value >= minValue) {
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

    scheduleRender() {
        if (this.#scheduleRenderTimer === null) {
            const task = Promise.resolve().then(() => {
                if (this.#scheduleRenderTimer === task) {
                    this.#scheduleRenderTimer = null;
                    this.render();
                }
            });

            this.#scheduleRenderTimer = task;
        }
    }

    render() {
        this.#scheduleRenderTimer = null;

        if (this.#width === 0 && this.#resizeObserver) {
            return;
        }

        const widthScale = 1 / (this.#width || 1000);
        const xScale = 1 / (this.zoomEnd - this.zoomStart);
        const xOffset = this.zoomStart * xScale;
        const firstEnter = !this.frameEls.size;
        const removeFrames = new Set(this.frameEls.keys());
        const visibleFrames = this.getVisibleFrames(
            this.rootFrame,
            this.zoomStart,
            this.zoomEnd,
            this.#minFrameWidth * widthScale
        );
        const enterFramesGroupEl =
            this.el.querySelector('.frames-group:empty') ||
            document.createElement('div');
        let maxDepth = 0;

        // add / update frame elements
        for (const frame of visibleFrames) {
            const className = `frame${frame.fade ? ' fade' : ''}${frame.selected ? ' selected' : ''}`;
            const x0 = Math.max(0, frame.x0 * xScale - xOffset);
            const x1 = Math.max(0, frame.x1 * xScale - xOffset);
            let frameEl = this.frameEls.get(frame);

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
                frameEl.style.setProperty('--color', this.#colorMapper(frame, this.#colorHue));

                const labelEl = frameEl.appendChild(document.createElement('div'));

                labelEl.className = 'frame-label';
                labelEl.textContent = frame.name;

                enterFramesGroupEl.append(frameEl);
                this.frameByEl.set(frameEl, frame);
                this.frameEls.set(frame, frameEl);
            } else {
                // update
                frameEl.className = className;
                frameEl.style.setProperty('--x0', x0.toFixed(8));
                frameEl.style.setProperty('--x1', x1.toFixed(8));
            }

            removeFrames.delete(frame);
        }

        // remove non-visible frames
        for (const frame of removeFrames) {
            this.frameEls.get(frame)?.remove();
            this.frameEls.delete(frame);
        }

        // finalize enter frames group element
        enterFramesGroupEl.className = 'frames-group frames-group_init-enter-state';
        setTimeout(() => enterFramesGroupEl.classList.remove('frames-group_init-enter-state'), 1);
        this.el.append(enterFramesGroupEl);

        // update chart level state
        this.el.classList.toggle('first-enter', firstEnter);
        this.el.style.setProperty('--max-depth', String(maxDepth));
        this.el.style.setProperty('--width-scale', widthScale.toFixed(8));
    }

    zoomFrame(frame: Frame | null = null) {
        frame = frame || this.rootFrame;

        if (frame === null) {
            return;
        }

        this.zoomStart = frame.x0;
        this.zoomEnd = frame.x1;

        // unfade nodes
        for (const node of this.fadedFrames) {
            this.fadedFrames.delete(node);
            node.fade = false;
        }

        // fade ancestors
        let cursor = frame.parent;

        while (cursor !== null) {
            this.fadedFrames.add(cursor);
            cursor.fade = true;
            cursor = cursor.parent;
        }

        // emit event
        this.emit('zoom', frame);

        // schedule render
        this.scheduleRender();
    }

    resetZoom() {
        this.zoomFrame(this.rootFrame); // zoom to root
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
    set colorMapper(colorMapper: FrameColorGenerator) {
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
        this.el = null;
    }
}
