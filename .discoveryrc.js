const v8logSupport = false;

module.exports = {
    name: 'CPU (pro)file',
    basedir: __dirname + '/app',
    darkmode: 'only',
    embed: true,
    upload: {
        accept: v8logSupport
            ? ['.cpuprofile', '.devtools', '.log', '.json', '.jsonxl']
            : ['.cpuprofile', '.devtools', '.json', '.jsonxl']
    },
    ...v8logSupport ? { encodings: './encodings' } : null,
    prepare: './prepare',
    data: './data',
    favicon: __dirname + '/app/img/favicon.png',
    view: {
        assets: [
            './pages/common.css',
            './pages/default.js',
            './pages/default.css',
            './pages/category.js',
            './pages/function.css',
            './pages/function.js',
            './pages/module.js',
            './pages/package.js',
            './views/misc/mode-regexp.css',
            './views/misc/mode-regexp.js',
            './views/duration.css',
            './views/duration.js',
            './views/flamechart.css',
            './views/flamechart.js',
            './views/flamechart-expand.css',
            './views/flamechart-expand.js',
            './views/loc-badge.css',
            './views/loc-badge.js',
            './views/nested-timings-tree.js',
            './views/page-indicator.css',
            './views/page-indicator.js',
            './views/page-indicator-timings.css',
            './views/page-indicator-timings.js',
            './views/subject-badges.css',
            './views/subject-badges.js',
            './views/subject-with-nested-timeline.css',
            './views/subject-with-nested-timeline.js',
            './views/text-with-unit.js',
            './views/time.css',
            './views/time.js',
            './views/time-ruler.css',
            './views/time-ruler.js',
            './views/timeline-profiles.css',
            './views/timeline-profiles.js',
            './views/timeline-segments.css',
            './views/timeline-segments.js',
            './views/timing-bar.css',
            './views/timing-bar.js',
            './views/update-on-timings-change.css',
            './views/update-on-timings-change.js'
        ]
    }
};
