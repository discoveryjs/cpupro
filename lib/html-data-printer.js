/* eslint-env node */
module.exports = function createHtmlDataPrinter(minChunkSize = 1024 * 1024, type = 'unknown/data', onDataChunk = '', onFinish = '') {
    const OPEN = `\n<script type="${type}">`;
    const CLOSE = `</script><script>\n(chunk=>{${
        onDataChunk
    }})(document.currentScript.previousSibling.text)</script>`;
    let ensureOPEN = OPEN;
    let bufferSize = 0;
    let tail = null;

    return {
        *push(chunk) {
            let safePart;

            if (tail === null && chunk.indexOf('</') === -1) {
                // fast path
                safePart = chunk;
            } else {
                // slow path, might has </script>
                const safeParts = (tail !== null ? tail + chunk : chunk)
                    .split(/<\/(script)/i);

                for (let i = 0; i < safeParts.length - 1; i += 2) {
                    yield `${ensureOPEN}${safeParts[i]}</${CLOSE}${OPEN}${safeParts[i + 1]}`;
                    ensureOPEN = '';
                    bufferSize = 6; // "script" (case insensitive)
                }

                safePart = safeParts[safeParts.length - 1];
            }

            if (bufferSize + safePart.length >= minChunkSize) {
                yield ensureOPEN + safePart + CLOSE;
                ensureOPEN = OPEN;
                bufferSize = 0;
                tail = null;
            } else {
                const tailCandidate = safePart.slice(-7).match(/<(\/(s(c(r(ip?)?)?)?)?)?$/i);
                tail = tailCandidate !== null
                    ? tailCandidate[0]
                    : null;

                if (tail !== null) {
                    safePart = safePart.slice(0, -tail.length);
                }

                if (safePart.length > 0) {
                    yield ensureOPEN + safePart;
                    ensureOPEN = '';
                    bufferSize += safePart.length;
                }
            }
        },
        *finish() {
            if (tail !== null) {
                yield ensureOPEN + tail + CLOSE;
            } else if (bufferSize > 0) {
                yield CLOSE;
            }

            yield `\n<script>${onFinish}</script>`;
        }
    };
};
