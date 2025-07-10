// type Entry = {
//     callFrame: CallFrame;
//     path: PathEntry[];
//     deopt: {
//         reason: string;
//         bailoutType: string;
//     }
// }
// type PathEntry = {
//     parent: PathEntry | null;
//     callFrame: CallFrame;
//     offset: number;
// }

discovery.view.define('deopt-card', [
    { view: 'block', className: 'deopt-path', content: [
        { view: 'block', className: 'self', content: 'text:path[].callFrame.name' },
        { view: 'inline-list', data: 'path[1:]', whenData: true, item: [
            'call-frame-badge',
            {
                view: 'badge',
                className: 'source-loc',
                data: `
                    offset.offsetToLineColumn(callFrame)
                        | is object ? \`:\${line}:\${column}\`
                `,
                whenData: true,
                content: 'html:replace(/:/, `<span class="delim">:</span>`)'
            }
        ] }
    ] },
    'call-frame-source-point:{ ...path[-1], limit: 32 }',
    { view: 'block', className: 'deopt-message', content: [
        // 'badge{ text: deopt.bailoutType }',
        'text:deopt.reason + " (" + deopt.bailoutType + ")"'
    ] }
]);
