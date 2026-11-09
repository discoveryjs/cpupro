import { equal, deepEqual } from '@discoveryjs/discovery/lib/core/utils/compare.js';
import * as ranges from '../../app/views/ruler-range.js';
import { evaluateModule } from './evaluate-module.js';

class Element {
    constructor(tag) {
        this.tag = tag;
        this.dataset = {};
        this.children = [];
        this.listeners = new Map();
        this.style = { values: new Map(), setProperty(name, value) {
            this.values.set(name, value);
        } };
        this.width = 317;
    }
    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    insertBefore(child, reference) {
        child.parentNode = this;
        this.children.splice(this.children.indexOf(reference), 0, child);
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
    let hitElements = [];
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
            elementsFromPoint: () => activeElement ? [...hitElements, activeElement] : [],
            elementFromPoint: () => hitElements[0]
        } },
        addHostElEventListener(name, callback) {
            hostEvents.set(name, callback);
        },
        addGlobalEventListener(name, callback) {
            globalEvents.set(name, callback);
        }
    };
    evaluateModule(new URL('../../app/views/ruler.js', import.meta.url), {
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
        // Gestures use one pointer at a fixed vertical position
        pointerDown(x, target) {
            pointerMove({ x, y: 5 });
            hostEvents.get('pointerdown')({ buttons: 1, pointerId: 1, x, y: 5, target });
        },
        wheel(x, event) {
            pointerMove({ x, y: 5 });
            const wheelEvent = { x, y: 5, deltaX: 0, deltaY: 0, ...event, prevented: false, preventDefault() {
                this.prevented = true;
            } };
            hostEvents.get('wheel')(wheelEvent);
            return wheelEvent.prevented;
        },
        pointerUp(x) {
            globalEvents.get('pointerup')({ pointerId: 1, x, y: 5 });
        },
        selectionHandle: (element, trigger) => element.querySelector('.view-ruler__selection-overlay-mover')
            .children.find(child => child.dataset.trigger === trigger),
        destroy: element => element.children.find(child => child.tag === 'destroy-ruler').onDestroy(),
        setActive(element, ...targets) {
            activeElement = element;
            hitElements = targets.length ? targets : [element];
        }
    };
}
