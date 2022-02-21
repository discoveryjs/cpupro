export default function(host, render) {
    let hideTimer;
    let popup = new host.view.Popup({
        className: 'flamechart-tooltip',
        position: 'pointer'
    });

    function tip() {
    }

    tip.show = function(d) {
        clearTimeout(hideTimer);
        popup.show(null, (el) => render(el, d.data));

        return tip;
    };

    tip.hide = function() {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => popup.hide(), 150);

        return tip;
    };

    tip.destroy = function() {
        clearTimeout(hideTimer);
        popup.hide();
        popup = null;
    };

    return tip;
}
