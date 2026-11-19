import { heapObjectLink } from './default-page/heap-snapshot.js';

// The objects a reference is from or to, by a reference record's field
const referenceCols = field => [
    { header: 'Type', content: 'text:type' },
    { header: 'Name', content: 'text:name' },
    {
        header: 'Object',
        content: {
            view: 'context',
            data: `#.heapSnapshot.objects[${field}]`,
            content: heapObjectLink
        }
    },
    { header: 'Self size', align: 'right', content: `text:#.heapSnapshot.objects[${field}].selfSize.bytes()` },
    { header: 'Retained size', align: 'right', content: `text:#.heapSnapshot.retainedSizes[${field}].bytes()` }
];

const pageContent = [
    {
        view: 'page-header',
        prelude: [
            'badge{ className: "type-badge", text: "Heap object" }',
            'badge{ text: type }'
        ],
        content: 'h1:`${name or "(" + type + ")"} @${id}`'
    },
    {
        view: 'page-indicators',
        content: [
            { title: 'Class', content: 'text:class.name' },
            { title: 'Self size', content: 'text:selfSize.bytes()' },
            { title: 'Retained size', content: 'text:snapshot.retainedSizes[index].bytes()' },
            { title: 'References', value: '=edges.size()' },
            { title: 'Retainers', value: '=retainers.size()' }
        ]
    },
    'h2:"References"',
    {
        view: 'table',
        data: 'edges',
        limit: 50,
        cols: referenceCols('to')
    },
    'h2:"Retainers"',
    {
        view: 'table',
        data: 'retainers',
        limit: 50,
        cols: referenceCols('from')
    }
];

// An object of a heap snapshot by its id, the id of the object in the snapshot's heap
discovery.page.define('heap-object', {
    view: 'context',
    // jora takes a negative index from the end, so a missing id selects nothing
    data: `
        heapSnapshots.(
            $node: nodes.columns.id.indexOf(#.id * 1);
            $node >= 0 ? objects[$node] : undefined
        )[0]
    `,
    content: {
        view: 'switch',
        content: [
            { when: 'no $', content: 'alert-warning:`No heap object with id ${#.id} found`' },
            { content: {
                view: 'context',
                context: '{ ...#, heapSnapshot: snapshot }',
                content: pageContent
            } }
        ]
    }
});
