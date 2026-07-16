import { fixDetailsScroll } from './common.js';

export function allPageHeader(content) {
    return {
        view: 'page-header',
        className: 'all-page-header',
        prelude: [
            'badge{ text: "Packages", className: #.page = "packages" ? "selected", href: #.page != "packages" ? "#packages" }',
            'badge{ text: "Modules", className: #.page = "modules" ? "selected", href: #.page != "modules" ? "#modules" }',
            'badge{ text: "Call frames", className: #.page = "call-frames" ? "selected", href: #.page != "call-frames" ? "#call-frames" }',
            'badge{ text: "Locations", className: #.page = "locations" ? "selected", href: #.page != "locations" ? "#locations" }'
        ],
        content
    };
}

export function allPageTable(extension) {
    return {
        view: 'table',
        className: 'all-page-table',
        limit: 100,
        data: 'sort(selfValue desc, totalValue desc)',
        postRender(el) {
            fixDetailsScroll(el);
        },
        ...extension
    };
}

export function allPageSummary(caption) {
    return {
        view: 'block',
        className: 'all-page-summary',
        content: [
            { view: 'block', content: [caption, 'text-numeric:size()'] },
            { view: 'block', content: ['text:`${"totalValue".metricName()}:`', 'metric:sum(=>selfValue)'] }
        ]
    };
}
