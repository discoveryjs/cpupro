const props = `is not array? | {
    color,
    text: #.props has no 'content' ? is (string or number or boolean) ?: text,
    content: undefined,
    value: undefined
} | overrideProps()`;

discovery.view.define('labeled-value', function(el, props, data, context) {
    const { color, text, content, value } = props;
    const renders = [];

    if (color) {
        el.style.setProperty('--color', color);
    }

    if (content) {
        renders.push(this.render(el, content, data, context));
    } else {
        el.append(document.createTextNode(text));
    }

    if (value) {
        const valueEl = el.appendChild(document.createElement('span'));

        valueEl.className = 'labeled-value__value';
        renders.push(this.render(valueEl, value, data, context));
    }

    return Promise.all(renders);
}, { tag: 'span', props });
