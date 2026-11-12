// An element as `utils.createElement` gives views, recording what a view sets on it: children, classes,
// styles set by `style.setProperty`, and event listeners, which `dispatch` calls
export function createElement(tagName, className = '') {
    const listeners = new Map();
    const element = {
        tagName,
        className,
        hidden: false,
        textContent: '',
        children: [],
        classList: new Set(),
        styles: new Map(),
        style: {
            setProperty(name, value) {
                element.styles.set(name, value);
            }
        },
        append(...children) {
            element.children.push(...children);
        },
        replaceChildren(...children) {
            element.children = children;
        },
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
        dispatch(type, event) {
            listeners.get(type)(event);
        }
    };

    return element;
}

// Shares of the displayed range before and after an extent, [start, end], as `setRangeCoverage()` sets them
export function rangeCoverage(element) {
    return [
        element.styles.get('--range-pad-start'),
        element.styles.get('--range-pad-end')
    ];
}
