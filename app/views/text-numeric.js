discovery.view.define('text-numeric', function(el, config, data) {
    const value = String(data);

    el.innerHTML = value.replace(
        /\..+$|\B(?=(\d{3})+(\D|$))/g,
        m => m || '<span class="num-delim"></span>'
    );
}, { tag: 'span'});
