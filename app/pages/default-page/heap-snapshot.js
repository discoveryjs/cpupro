// input: a heap snapshot
export const heapSnapshotSummary = [
    {
        view: 'page-indicators',
        content: [
            {
                title: 'Objects',
                hint: 'md:"#### Objects\\n\\nThe number of nodes of the snapshot: objects of the heap and synthetic nodes (roots and their groups)."',
                value: '=nodes.length'
            },
            {
                title: 'References',
                hint: 'md:"#### References\\n\\nThe number of edges of the snapshot: references from an object to another one, by a property, an element, a context variable or an internal field."',
                value: '=edges.length'
            },
            {
                title: 'Self size',
                hint: 'md:"#### Self size\\n\\nThe sum of the self sizes of all objects: the memory each object holds by itself, without the objects it references."',
                content: 'text:selfSize.bytes()'
            }
        ]
    },
    {
        view: 'table',
        data: 'nodeTypes.[count > 0].sort(selfSize desc)',
        cols: [
            { header: 'Type', content: 'text:name' },
            { header: 'Objects', align: 'right', sorting: 'count desc', content: 'text-numeric:count' },
            { header: 'Self size', align: 'right', sorting: 'selfSize desc', content: 'text:selfSize.bytes()' }
        ]
    }
];
