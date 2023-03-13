module.exports = {
    name: 'CPU (pro)file',
    cache: true,
    basedir: __dirname + '/app',
    upload: {
        accept: ['.cpuprofile', '.json']
    },
    prepare: './prepare',
    data: './data',
    view: {
        assets: [
            './pages/default.js',
            './pages/default.css',
            './pages/area.js',
            './pages/function.js',
            './pages/module.js',
            './pages/package.js',
            './views/duration.css',
            './views/duration.js',
            './views/flamechart.css',
            './views/flamechart.js',
            './views/loc-badge.css',
            './views/loc-badge.js',
            './views/module-badge.css',
            './views/module-badge.js',
            './views/package-badge.css',
            './views/package-badge.js',
            './views/page-indicator.css',
            './views/page-indicator.js',
            './views/the-spice-must-flow.css',
            './views/the-spice-must-flow.js',
            './views/timeline-segments.css',
            './views/timeline-segments.js',
            './views/timing-bar.css',
            './views/timing-bar.js'
        ]
    }
};
