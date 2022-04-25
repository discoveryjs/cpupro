export default function(host, render) {
    let hideTimer;
    let renderedFrame = null;
    let popup = new host.view.Popup({
        className: 'flamechart-tooltip',
        position: 'pointer'
    });

    return {
        show(frame) {
            clearTimeout(hideTimer);
            popup.show(null, renderedFrame !== frame ? (el) => render(el, frame.data) : undefined);
            renderedFrame = frame;
        },

        hide() {
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => popup.hide(), 150);
        },

        destroy() {
            clearTimeout(hideTimer);
            renderedFrame = null;
            popup.hide();
            popup = null;
        }
    };
}
