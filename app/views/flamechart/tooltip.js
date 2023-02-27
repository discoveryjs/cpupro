export default function(host, render) {
    let hideTimer;
    let renderedFrame = null;
    let popup = new host.view.Popup({
        className: 'flamechart-tooltip',
        position: 'pointer'
    });

    return {
        show(frame) {
            if (popup === null) {
                return;
            }

            clearTimeout(hideTimer);
            popup.show(null, renderedFrame !== frame ? (el) => render(el, frame) : undefined);
            renderedFrame = frame;
        },

        hide() {
            if (popup === null) {
                return;
            }

            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => popup.hide(), 150);
        },

        destroy() {
            if (popup === null) {
                return;
            }

            clearTimeout(hideTimer);
            renderedFrame = null;
            popup.destroy?.();
            popup = null;
        }
    };
}
