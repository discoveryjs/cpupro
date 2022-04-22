export default function(host, render) {
    let hideTimer;
    let renderedNode = null;
    let popup = new host.view.Popup({
        className: 'flamechart-tooltip',
        position: 'pointer'
    });

    function tip() {
    }

    tip.show = function(node) {
        clearTimeout(hideTimer);
        popup.show(null, renderedNode !== node ? (el) => render(el, node.data) : undefined);
        renderedNode = node;

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
