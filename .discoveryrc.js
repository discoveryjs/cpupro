module.exports = {
    name: 'CPU (pro)file',
    basedir: __dirname + '/app',
    embed: true,
    upload: {
        accept: ['.cpuprofile', '.json', '.jsonxl']
    },
    prepare: './prepare',
    data: './data',
    view: {
        assets: [
            './pages/common.css',
            './pages/default.js',
            './pages/default.css',
            './pages/area.js',
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
            './views/function-badge.css',
            './views/function-badge.js',
            './views/loc-badge.css',
            './views/loc-badge.js',
            './views/module-badge.css',
            './views/module-badge.js',
            './views/package-badge.css',
            './views/package-badge.js',
            './views/page-indicator.css',
            './views/page-indicator.js',
            './views/time.css',
            './views/time.js',
            './views/time-ruler.css',
            './views/time-ruler.js',
            './views/timeline-profiles.css',
            './views/timeline-profiles.js',
            './views/timeline-segments.css',
            './views/timeline-segments.js',
            './views/timing-bar.css',
            './views/timing-bar.js'
        ]
    }
};
