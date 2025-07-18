export const timingCols = [
    {
        header: 'Self time',
        className: 'timings self-time',
        sorting: 'selfTime desc, totalTime desc',
        colSpan: '=totalTime ? 1 : 3',
        contentWhen: 'selfTime or no totalTime',
        content: {
            view: 'switch',
            content: [
                { when: 'totalTime', content: 'duration:{ time: selfTime, total: #.data.totalTime }' },
                { content: 'no-samples' }
            ]
        }
    },
    {
        header: 'Nested time',
        className: 'timings',
        sorting: 'nestedTime desc, totalTime desc',
        when: 'totalTime',
        contentWhen: 'nestedTime',
        content: 'duration:{ time: nestedTime, total: #.data.totalTime }'
    },
    {
        header: 'Total time',
        className: 'timings',
        sorting: 'totalTime desc, selfTime desc',
        when: 'totalTime',
        content: 'duration:{ time: totalTime, total: #.data.totalTime }'
    }
];

export const callFramesCol = (data, moduleCol = false) => ({
    header: 'Call frames',
    className: 'number sampled-numbers',
    data,
    content: 'sampled-count-total{ hideZeroCount: true, count(=> totalTime?), total: size() }',
    details: [
        {
            view: 'table',
            data: `
                zip(=> entry, #.data.currentProfile.codesByCallFrame, => callFrame)
                .({
                    selfTime: left.selfTime,
                    nestedTime: left.nestedTime,
                    totalTime: left.totalTime,
                    entry: left.entry,
                    right
                })
            `,
            cols: [
                ...timingCols,
                ...moduleCol ? [{
                    header: 'Module',
                    className: 'subject-name',
                    sorting: 'entry.module.name ascN',
                    content: 'module-badge:entry'
                }] : [],
                {
                    header: '',
                    colWhen: '$[=>right]',
                    sorting: 'right.hotness | $ = "hot" ? 3 : $ = "warm" ? 2 : $ = "cold" ? 1 : 0 desc',
                    data: 'right',
                    contentWhen: 'hotness = "hot" or hotness = "warm"',
                    content: 'code-hotness-icon:topTier'
                },
                {
                    header: 'Call frame',
                    className: 'subject-name',
                    sorting: 'entry.name ascN, entry.module.name ascN',
                    content: 'badge:entry.marker() | { text: title, href }'
                }
            ]
        }
    ]
});

export function sessionExpandState(name, defaultValue = false, cond) {
    const fullname = `cpupro-${name}`;

    return {
        expanded: `=${cond ? `(${cond}).bool() and ` : ''}"getSessionSetting".callAction(${JSON.stringify(fullname)}, ${defaultValue})`,
        onToggle: `==>"setSessionSetting".callAction(${JSON.stringify(fullname)}, $)`
    };
}

const currentDetailsCellSelector = ':scope > tbody > .view-table-row > .view-table-cell.details-expanded';
export function fixDetailsScroll(tableEl) {
    tableEl.addEventListener('click', (event) => {
        // ignore click events in nested tables
        if (event.target?.closest('.view-table') !== tableEl) {
            return;
        }

        // lookup for activated details cell
        const oldDetailsEl = tableEl.querySelector(currentDetailsCellSelector);

        // bailout: will be a first activation (expanded details) if any, do nothing
        if (oldDetailsEl === null) {
            return;
        }

        // store the activated cell's row box
        const oldDetailsBeforeUpdateRowRect = oldDetailsEl.parentNode.getBoundingClientRect();
        const maybeNewDetailsEl = event.target.closest('.view-table-cell.details');
        const maybeNewDetailsBeforeUpdateRowRect = maybeNewDetailsEl?.parentNode?.getBoundingClientRect();

        // Promise.race() is redundant here since we create a Promise anyway
        new Promise(resolve => {
            const timeoutSignal = AbortSignal.timeout(0);
            // apply changes on the click event bubbling to the table element
            tableEl.addEventListener('click', resolve, { once: true, signal: timeoutSignal });
            // ensure changes are applied (at least on next tick) even if event bubbling was canceled
            timeoutSignal.addEventListener('abort', resolve);
        }).then(() => {
            const newDetailsEl = tableEl.querySelector(currentDetailsCellSelector);

            // activated details cell was changed
            if (newDetailsEl !== oldDetailsEl) {
                const oldDetailsRowRect = oldDetailsEl.parentNode.getBoundingClientRect();
                let scrollOffset = 0;

                if (newDetailsEl === null) {
                    // last details cell deactivated (collapsed)
                    // compute a scroll offset to move last active details cell on the same position on the screen
                    scrollOffset = Math.min(0, oldDetailsRowRect.top - oldDetailsBeforeUpdateRowRect.top);
                } else {
                    // the activation moved to another cell, try to stabilize position
                    const currentRowEl = newDetailsEl.parentNode;
                    const currentRowRect = currentRowEl.getBoundingClientRect();
                    const nextRowBox = currentRowEl.nextSibling.getBoundingClientRect();

                    // stabilize details content offset first
                    scrollOffset = nextRowBox.top - currentRowRect.bottom;

                    // otherwise stabilize details cell
                    if (scrollOffset === 0) {
                        const oldOffset = oldDetailsRowRect.top - oldDetailsBeforeUpdateRowRect.top;
                        const newOffset = maybeNewDetailsBeforeUpdateRowRect
                            ? currentRowRect.top - maybeNewDetailsBeforeUpdateRowRect.top
                            : 0;

                        scrollOffset = newOffset < 0 && oldOffset !== 0
                            ? (oldOffset < 0 ? Math.min(oldOffset, newOffset) : newOffset)
                            : 0;
                    }
                }

                if (scrollOffset !== 0) {
                    let offsetParent = tableEl.offsetParent;

                    // look up for a proper offsetParent - an element to scroll
                    // <td>, <th> and <table> are offsetParent even with position:static
                    while (offsetParent !== null && getComputedStyle(offsetParent).position === 'static') {
                        offsetParent = offsetParent.offsetParent;
                    }

                    if (offsetParent) {
                        offsetParent.scrollTop += scrollOffset;
                    }
                }
            }
        });
    }, true);
}
