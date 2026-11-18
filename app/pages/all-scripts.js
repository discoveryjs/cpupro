import { allPageHeader, allPageTable } from './all-page-common.js';

const bytes = field => `text:${field} is number ? ${field}.bytes() : "Unavailable"`;

const unicodeCharacters = {
    view: 'table',
    data: 'source.sourceUnicodeCharacters()',
    limit: 25,
    emptyText: 'No characters outside Latin-1',
    cols: [
        { header: 'Character', content: 'text:character' },
        { header: 'Code point', content: 'text:code' },
        { header: 'Offset', align: 'right', content: 'text-numeric:offset' },
        { header: 'Source context', content: {
            view: 'source', className: 'utf-source', syntax: 'js', lineNum: false, actionCopySource: false,
            data: '{ content: fragment, refs: [{ range: [start, end], className: "utf-character" }] }'
        } }
    ]
};

discovery.page.define('scripts', {
    view: 'context',
    context: '{ ...#, scopeProfile: #.primaryProfile }',
    modifiers: [
        allPageHeader([
            'h1:"All scripts"',
            { view: 'input', name: 'filter', type: 'regexp', placeholder: 'Filter scripts' },
            { view: 'checkbox', name: 'originals', content: 'text:"Include source-map originals"' },
            { view: 'checkbox', name: 'utfOnly', content: 'text:"Include UTF-16 only scripts"' }
        ])
    ],
    content: {
        view: 'context',
        // scripts are parsed on demand, only those that are listed and not parsed yet
        data: `
            (scopeProfile().thread.scripts or [])
                .[script and (no script.originalFor or #.originals)]
                .[script.url ~= #.filter]
                .parseScriptSources()
        `,
        content: {
            view: 'context',
            data: `
                $thread: scopeProfile().thread;
                $hasEvents: $thread.compilations.size() > 0;
                $.(script.scriptSourceSummary(compilation, $hasEvents))
                    .[no #.utfOnly or bytesPerChar > 1]
            `,
            content: pageContent()
        }
    }
});

function pageContent() {
    return [
        allPageTable({
            data: 'sort(byteLength ?? -1 desc, script.url ascN)',
            emptyText: 'No scripts',
            cols: [
                { header: { text: 'Source bytes', tooltip: 'text:"Estimated flat string payload: one byte per Latin-1 code unit, otherwise two. Excludes object overhead and compression."' },
                    align: 'right', sorting: 'byteLength ?? -1 desc',
                    content: bytes('byteLength'),
                    detailsWhen: 'script.source is string',
                    details: 'script-source:script'
                },
                { header: 'Storage', sorting: 'bytesPerChar desc',
                    className: 'nowrap',
                    content: 'text:bytesPerChar = 1 ? "Latin-1" : bytesPerChar = 2 ? "UTF-16" : "Unavailable"',
                    detailsWhen: 'script.sourceMetrics',
                    details: {
                        view: 'context',
                        data: `{
                        $length: script.source.size();
                        $metrics: script.sourceMetrics;
                        source: script.source,
                        codeUnits: $length,
                        codePoints: $length - $metrics.surrogatePairs,
                        supplementary: $metrics.surrogatePairs,
                        extraBytes: $metrics.byteLength - $length,
                        groups: [
                            { name: "Latin-1 (U+0000..U+00FF)", count: $length - $metrics.nonLatin1CodeUnits },
                            { name: "Outside Latin-1 (> U+00FF)", count: $metrics.nonLatin1CodeUnits }
                        ].({ ..., fraction: $length ? count / $length : 0 })
                    }`,
                        content: [
                            { view: 'table', data: 'groups', cols: [
                                { header: 'Source code units', content: 'text:name' },
                                { header: 'Count', align: 'right', content: 'text-numeric:count' },
                                { header: '%', align: 'right', content: 'text:fraction.percent(4)' }
                            ] },
                            { view: 'block', content: ['text:"UTF-16 code units: "', 'text-numeric:codeUnits'] },
                            { view: 'block', content: ['text:"Code points: "', 'text-numeric:codePoints'] },
                            { view: 'block', content: ['text:"Supplementary characters (surrogate pairs): "', 'text-numeric:supplementary'] },
                            { view: 'block', content: ['text:"Extra payload from two-byte storage: "', 'text:extraBytes.bytes()'] },
                            unicodeCharacters
                        ]
                    }
                },
                { header: { text: 'UTF chars', tooltip: 'text:"Source characters outside Latin-1 (> U+00FF). A surrogate pair counts as one character; literal Unicode escapes are not decoded."' },
                    align: 'right',
                    sorting: '(script.sourceMetrics ? script.sourceMetrics.nonLatin1CodeUnits - script.sourceMetrics.surrogatePairs : -1) desc',
                    context: '{ ...#, unicodeSource: script.source }',
                    data: 'script.sourceMetrics ? script.sourceMetrics.nonLatin1CodeUnits - script.sourceMetrics.surrogatePairs : null',
                    content: 'text-numeric:$ is number ? $ : "Unavailable"',
                    detailsWhen: '$ is number and $ > 0',
                    details: {
                        view: 'context', data: '{ source: #.unicodeSource }',
                        content: unicodeCharacters
                    }
                },
                { header: 'Functions', align: 'right', sorting: 'functions desc',
                    content: 'text:functions is number ? functions : "Unavailable"',
                    detailsWhen: 'functions is number',
                    details: {
                        view: 'table', data: 'script.scriptSourceFunctions(compilation).sort(ownBytes desc)', limit: 50,
                        cols: [
                            { header: 'Own bytes', align: 'right', sorting: 'ownBytes desc', content: bytes('ownBytes') },
                            { header: 'State', sorting: 'state ascN', content: 'text:state' },
                            { header: 'Function / range', sorting: 'name ascN', content: 'text:name',
                                details: [
                                    'source{ syntax: "js", source: script.source[start:end] }'
                                ] },
                            { header: 'Kind', content: 'text:type' },
                            { header: 'Start', content: 'text-numeric:start' },
                            { header: 'End', content: 'text-numeric:end' }
                        ]
                    }
                },
                { header: { text: 'Observed compiled', tooltip: 'text:"Sum of own source sizes (excluding nested runtime ranges) in compiled or optimized state, including top-level script code. Each UTF-16 code unit counts as 1 byte for a Latin-1 script or 2 bytes for the entire UTF-16 script. Observed compilation is not proof of execution; events before recording are unknown."' },
                    align: 'right', sorting: 'compiledBytes ?? -1 desc',
                    content: bytes('compiledBytes'), detailsWhen: 'compiledBytes is number',
                    details: [
                        { view: 'table', data: 'states', cols: [
                            { header: 'State', content: 'text:name' },
                            { header: 'Own bytes', align: 'right', content: bytes('bytes') }
                        ] },
                        { view: 'block', when: 'unmatched', content: ['text:"Unmatched function starts: "', 'text-numeric:unmatched'] },
                        { view: 'block', when: 'unknownStages', content: ['text:"Unclassified stages: "', 'text:unknownStages.join(", ")'] }
                    ]
                },
                { header: '%', align: 'right', sorting: 'compiledBytes / byteLength desc',
                    content: 'text:compiledBytes is number and byteLength > 0 ? (compiledBytes / byteLength).percent(1) : "–"'
                },
                { header: 'Source map', sorting: 'script.sourceMap desc',
                    content: 'text:script.originalFor ? "Original" : script.sourceMap ? "Yes" : script.sourceMapUrl ? "Referenced" : "No"' },
                { header: 'Script', sorting: 'script.url ascN',
                    content: 'text-match{ text: script.url or "(anonymous script)", match: #.filter }' }
            ]
        }),

        {
            view: 'block', className: 'all-page-summary scripts-summary',
            content: [
                { view: 'block', content: ['text:"Scripts: "', 'text-numeric:size()'] },
                { view: 'block', content: ['text:"Source bytes: "', 'text:sum(=>byteLength or 0).bytes()'] },
                { view: 'block', content: ['text:"Observed compiled: "', 'text:.[compiledBytes is number] | size() ? sum(=>compiledBytes).bytes() : "Unavailable"'] }
            ]
        }
    ];
}
