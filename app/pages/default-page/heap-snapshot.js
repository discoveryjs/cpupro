// input: a heap snapshot
export const heapObjectLink = {
    view: 'link',
    href: '="#heap-object:" + id',
    text: '=`${name or "(" + type + ")"} @${id}`'
};

// The objects of a class, the first of them in their order
const classObjects = {
    view: 'table',
    data: 'objects[:100].(#.heapSnapshot.objects[$])',
    limit: 25,
    cols: [
        { header: 'Object', content: heapObjectLink },
        { header: 'Self size', align: 'right', content: 'text:selfSize.bytes()' }
    ]
};

export const heapSnapshotSummary = {
    view: 'context',
    context: '{ ...#, heapSnapshot: $ }',
    content: [
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
                },
                {
                    title: 'Classes',
                    hint: 'md:"#### Classes\\n\\nObjects and natives are classed by their constructor names, other nodes by their types."',
                    value: '=classes.count(=> count > 0)'
                }
            ]
        },
        'h2:"Classes"',
        {
            view: 'table',
            data: 'classes.[count > 0].sort(selfSize desc)',
            limit: 50,
            cols: [
                { header: 'Class', content: 'text:name', details: classObjects },
                { header: 'Type', content: 'text:type' },
                { header: 'Objects', align: 'right', sorting: 'count desc', content: 'text-numeric:count' },
                { header: 'Self size', align: 'right', sorting: 'selfSize desc', content: 'text:selfSize.bytes()' }
            ]
        },
        'h2:"Types"',
        {
            view: 'table',
            data: 'nodeTypes.[count > 0].sort(selfSize desc)',
            cols: [
                { header: 'Type', content: 'text:name' },
                { header: 'Objects', align: 'right', sorting: 'count desc', content: 'text-numeric:count' },
                { header: 'Self size', align: 'right', sorting: 'selfSize desc', content: 'text:selfSize.bytes()' }
            ]
        }
    ]
};
