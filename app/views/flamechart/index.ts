import { generateColorVector } from './colorUtils';
import { calculateColor } from './colorScheme';
import { EventEmitter } from './event-emmiter';

type FrameElement = HTMLElement;
type FrameColorGenerator = (frame: Frame, colorHue: string | null) => string;
type SetDataOptions = {
    name?(data: any): string;
    value?(data: any): number;
    children?(data: any): any[] | null | undefined;
    childrenSort?: true | ((a: any, b: any) => number);
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
    data: any;
    name: string;
    value: number;
    depth: number;
    x0: number;
    x1: number;
    fade: boolean;
    selected: boolean;

    constructor(parent: Frame, data: any) {
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

const defaultGetName: SetDataOptions['name'] = (frameData: any) => frameData.name;
const defaultGetValue: SetDataOptions['value'] = (frameData: any) => frameData.value;
const defaultGetChildren: SetDataOptions['children'] = (frameData: any) => frameData.children;

function ensureFunction<T, U>(value: T, fallback: U): T | U {
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

    return calculateColor(hue, vector);
}

export class FlameChart extends EventEmitter<Events> {
    el: HTMLElement;

    #colorMapper: FrameColorGenerator = defaultColorMapper;
    #colorHue: string | null = null;
    #scheduleRenderTimer: Promise<void> | null = null;

    #width = 1000; // graph width
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

        return chartEl;
    }

    findFrameByEl(cursor: Node) {
        if (this.el.contains(cursor)) {
            while (cursor && cursor !== this.el) {
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
                this.selectedFrame = this.selectedFramesStack.pop();
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

    setData<T>(rootData: T, options?: SetDataOptions) {
        this.resetFrameRefs();

        options = options || {};

        const getName = ensureFunction(options.name, defaultGetName);
        const getValue = ensureFunction(options.value, defaultGetValue);
        const getChildren = ensureFunction(options.children, defaultGetChildren);
        const childrenSort = ensureFunction(options.childrenSort !== true ? options.childrenSort : (a: any, b: any) => {
            const nameA = getName(a);
            const nameB = getName(b);
    
            return nameA > nameB ? 1 : nameA < nameB ? -1 : 0;
        }, false);

        // creating a precomputed hierarchical structure
        let parent = this.rootFrame = new Frame(null, rootData);
        parent.name = getName(rootData);
        parent.value = getValue(rootData);

        while (parent !== null) {
            let children = getChildren(parent.data);

            if (Array.isArray(children)) {
                if (childrenSort !== false) {
                    // use slice() to avoid data mutation
                    children = children.slice().sort(childrenSort);
                }

                let x0 = parent.x0;
                let prev = null;
                let parentNext = parent.next;

                for (const childData of children) {
                    const child = new Frame(parent, childData);

                    child.name = getName(childData);
                    child.value = getValue(childData);
                    child.depth = parent.depth + 1;
                    child.x0 = x0;
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
        const minValue = (end - start) * root.value * minScale;
        const nodeList: Frame[] = [];
        let node = root;

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

        const widthScale = 1 / this.#width;
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
            this.frameEls.get(frame).remove();
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

    get width() {
        return this.#width;
    }
    set width(width: number) {
        this.#width = width;
        this.scheduleRender();
    }

    destroy() {
        this.emit('destroy');

        this.resetFrameRefs();

        this.el.remove();
        this.el = null;
    }
}
