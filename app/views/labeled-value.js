const props = `is not array? | {
    color,
    text: #.props has no 'content' ? is (string or number or boolean) ?: text,
    content: undefined,
    value is number
} | overrideProps()`;

discovery.view.define('labeled-value', function(el, props, data, context) {
    const { color, text, content, value } = props;
    const labelEl = el.appendChild(document.createElement('span'));
    const renders = [];

    if (color) {
        labelEl.style.setProperty('--color', color);
    }

    labelEl.className = 'labeled-value__label';

    if (content) {
        renders.push(this.render(labelEl, content, data, context));
    } else {
        labelEl.append(document.createTextNode(text));
    }

    if (value) {
        const valueEl = el.appendChild(document.createElement('span'));

        valueEl.className = 'labeled-value__value';
        renders.push(this.render(valueEl, value, data, context));
    }

    return Promise.all(renders);
}, { tag: 'span', props });


discovery.view.define('labeled-value-list', function(el, props, data, context) {
    return this.render(el, this.composeConfig('list', props), data, context);
});
