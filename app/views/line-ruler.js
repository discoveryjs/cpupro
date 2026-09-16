const { resolveScopeProfileLine } = require('../jora/profile.js');
const { formatMicrosecondsTime } = require('../prepare/misc/time-utils.js');

function formatMemory(size, total) {
    switch (true) {
        case total < 1_000_000:
            return `${(size / 1_000).toFixed(1).replace(/\.0$/, '')}Kb`;

        default:
            return `${(size / 1_000_000).toFixed(1).replace(/\.0$/, '')}Mb`;
    }
}

discovery.view.define('line-ruler', function(el, { line, ...props }, data, context) {
    const scopeLine = resolveScopeProfileLine(line, context);

    return this.render(el, {
        ...props,
        view: 'ruler',
        formatLabel: scopeLine.type === 'memline'
            ? formatMemory
            : scopeLine.type === 'timeline'
                ? formatMicrosecondsTime
                : String
    }, data, context);
}, { tag: false });
