import { readFileSync } from 'node:fs';
import { equal, deepEqual } from '@discoveryjs/discovery/lib/core/utils/compare.js';
import { runInNewContext } from 'node:vm';
import * as ranges from '../../app/views/ruler-range.js';

class Element {
    constructor(tag) {
        this.tag = tag;
        this.dataset = {};
        this.children = [];
        this.listeners = new Map();
        this.style = { setProperty() {} };
        this.width = 317;
    }
    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    replaceChildren(...children) {
        this.children = [];
        for (const child of children) {
            this.appendChild(child);
        }
    }
    getBoundingClientRect() {
        return { left: 0, width: this.width };
    }
    contains(element) {
        return this === element || this.children.some(child => child.contains(element));
    }
    querySelector(selector) {
        for (const child of this.children) {
            if (selector === '.' + child.className) {
                return child;
            }
            const result = child.querySelector(selector);
            if (result) {
                return result;
            }
        }
        return null;
    }
    addEventListener(name, callback) {
        this.listeners.set(name, callback);
    }
    setPointerCapture(pointerId) {
        this.pointerId = pointerId;
    }
    hasPointerCapture(pointerId) {
        return this.pointerId === pointerId;
    }
    releasePointerCapture() {
        this.pointerId = null;
    }
    closest() {
        return null;
    }
}

export function createRulerHarness(render = () => {}) {
    const hostEvents = new Map();
    const globalEvents = new Map();
    let pointerMove;
    let renderRuler;
    let activeElement = null;
    let tooltip = null;
    const utils = {
        equal,
        deepEqual,
        pointerXY: {
            subscribe(callback) {
                pointerMove = callback;
            }
        },
        createElement(tag, attrs, children = []) {
            const element = new Element(tag);
            if (typeof attrs === 'string') {
                element.className = attrs;
            } else if (attrs) {
                element.className = attrs.class;
                if (attrs['data-trigger']) {
                    element.dataset.trigger = attrs['data-trigger'];
                }
            }
            for (const child of children) {
                element.appendChild(child);
            }
            return element;
        }
    };
    const discovery = {
        view: {
            Popup: class {
                show(element, callback) {
                    tooltip = callback;
                }
                hide() {
                    tooltip = null;
                }
            },
            define(name, render) {
                renderRuler = render;
            }
        },
        dom: { root: {
            elementsFromPoint: () => activeElement ? [activeElement] : [],
            elementFromPoint: () => activeElement
        } },
        addHostElEventListener(name, callback) {
            hostEvents.set(name, callback);
        },
        addGlobalEventListener(name, callback) {
            globalEvents.set(name, callback);
        }
    };
    runInNewContext(readFileSync(new URL('../../app/views/ruler.js', import.meta.url), 'utf8'), {
        discovery,
        document: { createElement: tag => new Element(tag) },
        HTMLElement: Element,
        customElements: { define() {} },
        require(id) {
            if (id === '@discoveryjs/discovery') {
                return { utils };
            }
            if (id === './ruler-range.js') {
                return ranges;
            }
            if (id === './ruler.usage.js') {
                return { default: {} };
            }
            throw new Error('Unexpected dependency: ' + id);
        }
    });

    return {
        hostEvents,
        globalEvents,
        createElement: tag => new Element(tag),
        render: (...args) => renderRuler.call({ render }, ...args),
        showTooltip: () => tooltip?.(new Element('tooltip')),
        move: position => pointerMove(position),
        setActive(element) {
            activeElement = element;
        }
    };
}
