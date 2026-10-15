const functionTable = {
    view: 'table',
    cols: [
        { header: 'Self bytes', content: 'text:selfBytes' },
        { header: 'Total bytes', content: 'text:totalBytes' },
        { header: 'Function', content: 'text:name' },
        { header: 'Script', content: 'text:url' },
        { header: 'Start', content: 'text:start' }
    ]
};

const functionRows = `
    callFrames.filtered.dict.entries
        .[totalValue]
        .sort(selfValue desc, totalValue desc)
        .({
            name: entry.name,
            url: entry.script.url or "",
            start: entry.start,
            selfBytes: selfValue,
            totalBytes: totalValue
        })
`;

export default async function aliveAllocations(model, { options }) {
    if (!options.thread) {
        throw new Error('Specify --option thread=<name|tid>');
    }

    const profiles = model.query(`
        profiles.[thread.name = #.thread or thread.tid = #.tid]
    `, model.data, { ...model.getContext(), thread: options.thread, tid: Number(options.thread) });

    if (profiles.length !== 1) {
        throw new Error(`Thread ${options.thread} matched ${profiles.length} profiles; select one profile by thread ID`);
    }

    const profile = profiles[0];
    const line = profile.memline;

    if (!line) {
        throw new Error(`Thread ${options.thread} has no allocation population`);
    }

    const breakdown = line.breakdowns.find(entry => entry.kind === 'location');

    if (!breakdown?.callFrames) {
        throw new Error('The locations breakdown is unavailable');
    }

    const attributes = model.query(`{
        type: lineAttribute("allocationType"),
        space: lineAttribute("allocationSpace"),
        stage: lineAttribute("allocationCompilationStage")
    }`, line, model.getContext());
    const liveness = line.filters.get('allocationLiveness');
    const stage = line.filters.get('allocationCompilationStage');

    if (!liveness || !attributes.type || !attributes.space) {
        throw new Error('Allocation lifespan, type and space attributes are required');
    }

    if (!stage || !attributes.stage?.dict.includes('none')) {
        throw new Error('Recorded compilation stages are required to exclude covered allocations');
    }

    const limit = options.limit === undefined ? 50 : Number(options.limit);

    if (!Number.isInteger(limit) || limit < 1) {
        throw new Error('The function table limit must be a positive integer');
    }

    const saved = line.filters.filters.map(filter => ({ filter, mode: filter.mode, keys: filter.selectedKeys }));
    const savedRanges = [line.range, line.viewport].map(view => ({ view, ranges: view.ranges }));

    try {
        line.range.resetRange();
        line.viewport.resetRange();
        line.filters.batch(() => {
            line.filters.allowAll();
            liveness.setSelection('include', ['alive']);
        });

        const alive = await model.queryChain(() => ({ attributes, breakdown })).query(`{
            types: attributes.type.attributeSampleTotals(breakdown.populationFiltered).sort(size desc),
            spaces: attributes.space.attributeSampleTotals(breakdown.populationFiltered).sort(size desc),
            functions: breakdown.(${functionRows})
        }`).render([
            { view: 'h2', content: 'text:"Alive allocations by type"' },
            { view: 'table', data: 'types.[count]', limit: false, cols: [
                { header: 'Type', content: 'text:entry' },
                { header: 'Count', content: 'text:count' },
                { header: 'Bytes', content: 'text:size' }
            ] },
            { view: 'h2', content: 'text:"Alive allocations by space"' },
            { view: 'table', data: 'spaces.[count]', limit: false, cols: [
                { header: 'Space', content: 'text:entry.name' },
                { header: 'Count', content: 'text:count' },
                { header: 'Bytes', content: 'text:size' }
            ] },
            { view: 'h2', content: `text:"Alive allocations by function (locations, top ${limit} by self bytes)"` },
            { ...functionTable, data: 'functions', limit },
            { view: 'text', data: 'types | `Alive total: ${sum(=>count)} allocations, ${sum(=>size)} bytes`' }
        ]);

        stage.setSelection('include', ['none']);

        const outside = await model.queryChain(() => ({ attributes, breakdown })).query(`{
            types: attributes.type.attributeSampleTotals(breakdown.populationFiltered),
            functions: breakdown.(${functionRows})
        }`).render([
            { view: 'h2', content: `text:"Alive allocations by function outside compilation events (top ${limit} by self bytes)"` },
            { ...functionTable, data: 'functions', limit },
            { view: 'text', data: 'types | `Outside compilation total: ${sum(=>count)} allocations, ${sum(=>size)} bytes`' }
        ]);

        return `# ${profile.thread.name} (pid=${profile.thread.pid}, tid=${profile.thread.tid})\n\n${alive.text}\n\n${outside.text}`;
    } finally {
        line.filters.batch(() => {
            for (const { filter, mode, keys } of saved) {
                filter.setSelection(mode, keys);
            }
        });

        for (const { view, ranges } of savedRanges) {
            view.setRanges(ranges);
        }
    }
}
