import { unavailableSourceView } from './common.js';

discovery.view.define('script-source', {
    view: 'switch',
    content: [
        { when: 'hasSource()', content: {
            view: 'source',
            className: 'cpupro-source',
            data: `{
                $callFrames;
                $callFrameCodes: #.currentProfile.codesByScript[=> script = @].callFrameCodes or callFrames.({
                    callFrame: $,
                    codes: []
                });
                $callFrameCodesWithRange: $callFrameCodes.[callFrame | start >= 0 and end >= start];
                $tooltipView: [
                    'badge:callFrameCodes.callFrame.name',
                    'html:"<br>"',
                    {
                        view: 'inline-list',
                        data: 'callFrameCodes.codes',
                        whenData: true,
                        item: [
                            { view: 'text', when: '#.index', text: "\xa0→ " },
                            'code-tier-badge:tier',
                            'text:" " + tier + (inlined ? " (inlined: " + fns.size() + ")" : "")'
                        ]
                    }
                ];

                syntax: "js",
                content: source.replace(/\\n$/, ""),
                $callFrameCodes,
                marks: $callFrameCodesWithRange.({
                    className: 'function-tag',
                    offset: callFrame.start,
                    content: 'text:tiers',
                    tiers: codes
                        |? size() = 1
                            ? tier[].abbr()
                            : size() <= 3
                                ? tier.(abbr()).join(' ')
                                : tier[].abbr() + ' … ' + tier[-1].abbr()
                        : "ƒn"
                }),
                refs: $callFrameCodesWithRange.({
                    className: 'function',
                    range: [callFrame.start, callFrame.end],
                    href: callFrame.marker('call-frame').href,
                    callFrameCodes: $,
                    tooltip: $tooltipView
                })
            }`,
            postRender(el) {
                const contentEl = el.querySelector('.view-source__content');

                contentEl.addEventListener('click', (event) => {
                    const pseudoLinkEl = event.target.closest('.view-source .spotlight[data-href]');

                    if (pseudoLinkEl && contentEl.contains(pseudoLinkEl)) {
                        discovery.setPageHash(pseudoLinkEl.dataset.href);
                    }
                });
            }
        } },
        { content: unavailableSourceView }
    ]
});
