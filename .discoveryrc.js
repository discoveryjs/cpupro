module.exports = {
    name: 'CPU profile discovery',
    cache: true,
    basedir: __dirname + '/src',
    upload: {
        accept: ['.cpuprofile']
    },
    prepare: './prepare',
    data: './data',
    view: {
        assets: [
            './pages/default.js',
            './pages/area.js',
            './pages/function.js',
            './pages/module.js',
            './pages/package.js',
            './views/duration.css',
            './views/duration.js',
            './views/module-badge.css',
            './views/module-badge.js',
            './views/package-badge.css',
            './views/package-badge.js',
            './views/the-spice-must-flow.css',
            './views/the-spice-must-flow.js',
            './views/timeline-segments.css',
            './views/timeline-segments.js',
            './views/timing-bar.css',
            './views/timing-bar.js'
        ]
    }
};
