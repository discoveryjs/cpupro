export default function(host, render) {
    let hideTimer;
    let renderedSpan = null;
    let popup = new host.view.Popup({
        className: 'view-track-timeline__tooltip',
        position: 'pointer',
        positionMode: 'natural',
        showDelay: 150
    });

    return {
        show(span) {
            if (popup === null) {
                return;
            }

            clearTimeout(hideTimer);
            popup.show(null, renderedSpan !== span ? (el) => render(el, span) : undefined);
            renderedSpan = span;
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
            renderedSpan = null;
            popup.destroy?.();
            popup = null;
        }
    };
}
