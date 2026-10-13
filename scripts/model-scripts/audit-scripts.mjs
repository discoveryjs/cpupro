function indexRanges(script) {
    const byStart = new Map();

    for (const [index, range] of (script.functionRanges || []).entries()) {
        let matches = byStart.get(range.callFrameStart);

        if (!matches) {
            byStart.set(range.callFrameStart, matches = []);
        }

        matches.push({ index, range });
    }

    return byStart;
}

function bucket(map, key) {
    let entry = map.get(key);

    if (!entry) {
        map.set(key, entry = { count: 0, bytes: 0 });
    }

    return entry;
}

function distribution(map) {
    return Array.from(map, ([name, values]) => ({ name, ...values }))
        .sort((first, second) => second.bytes - first.bytes || second.count - first.count);
}

function auditAllocations(model, profile, entriesById, rangesByScript) {
    const line = profile.memline;

    if (!line) {
        return null;
    }

    const attributes = new Map(line.attributes.map(attribute => [attribute.name, attribute]));
    const type = attributes.get('allocationType');
    const stage = attributes.get('allocationCompilationStage');
    const owner = attributes.get('allocationOwner');
    const byType = new Map();
    const byStage = new Map();
    const byScript = new Map();
    const byFunction = new Map();
    const byIdentity = new Map();
    const cross = new Map();
    const groups = new Map();
    const records = (profile.thread.compilations || []).filter(record =>
        record.allocationStart !== null && record.allocationEnd > record.allocationStart
    ).sort((first, second) => first.allocationStart - second.allocationStart ||
        second.allocationEnd - first.allocationEnd || first.tm - second.tm || second.duration - first.duration);
    const active = [];
    let cursor = 0;
    let ownerMismatches = 0;
    let totalBytes = 0;

    for (let index = 0; index < line.values.length; index++) {
        const bytes = line.values[index];
        const ownerIndex = owner?.values[index] ?? -1;
        const stageIndex = stage?.values[index] ?? -1;
        const typeIndex = type?.values[index] ?? -1;

        while (active.length && active.at(-1).allocationEnd < index + 1) {
            active.pop();
        }

        while (cursor < records.length && records[cursor].allocationStart < index + 1) {
            const record = records[cursor++];

            if (record.allocationEnd >= index + 1) {
                active.push(record);
            }
        }

        const expectedOwner = active.at(-1);
        const actualOwner = owner?.dict[ownerIndex];

        if (expectedOwner ? !actualOwner || actualOwner.scriptId !== expectedOwner.scriptId || actualOwner.start !== expectedOwner.start : actualOwner) {
            ownerMismatches++;
        }

        let stages = groups.get(ownerIndex);

        if (!stages) {
            groups.set(ownerIndex, stages = new Map());
        }

        let types = stages.get(stageIndex);

        if (!types) {
            stages.set(stageIndex, types = new Map());
        }

        const totals = bucket(types, typeIndex);

        totals.count++;
        totals.bytes += bytes;
        totalBytes += bytes;
    }

    for (const [ownerIndex, stages] of groups) {
        const identity = owner?.dict[ownerIndex];
        const entry = identity ? entriesById.get(identity.scriptId) : null;
        const script = entry?.script;
        const matches = script ? rangesByScript.get(script).get(identity.start) || [] : [];
        let resolution = '(no owner)';

        if (identity) {
            if (!script) {
                resolution = '(script unresolved)';
            } else if (script.functionRanges === null) {
                resolution = '(source unparsed)';
            } else if (identity.start === 0 && matches.length > 0) {
                resolution = '(script/function ambiguous)';
            } else if (matches.length > 1) {
                resolution = '(function ambiguous)';
            } else if (matches.length === 1) {
                resolution = 'function';
            } else {
                resolution = identity.start === 0 ? 'script' : '(function unresolved)';
            }
        }

        const scriptKey = identity?.scriptId ?? '(no script)';
        const functionKey = identity ? `${identity.scriptId}:${identity.start}` : '(no owner)';

        for (const [stageIndex, types] of stages) {
            const stageName = stage?.dict[stageIndex] ?? '(unknown stage)';

            for (const [typeIndex, totals] of types) {
                const typeName = type?.dict[typeIndex] ?? '(unknown type)';
                const crossKey = JSON.stringify([stageName, scriptKey, typeName]);

                for (const aggregate of [
                    bucket(byType, typeName),
                    bucket(byStage, stageName),
                    bucket(byScript, scriptKey),
                    bucket(byFunction, functionKey),
                    bucket(byIdentity, resolution),
                    bucket(cross, crossKey)
                ]) {
                    aggregate.count += totals.count;
                    aggregate.bytes += totals.bytes;
                }
            }
        }
    }

    return {
        count: line.values.length,
        bytes: totalBytes,
        stageMismatches: model.query('allocationStageMismatches()', profile, model.getContext()),
        ownerMismatchesAssumingIds1ToN: owner && records.every(record => record.allocationStart >= 0 && record.allocationEnd <= line.values.length)
            ? ownerMismatches : null,
        attributes: line.attributes.map(attribute => ({ name: attribute.name, length: attribute.values.length })),
        byType: distribution(byType),
        byStage: distribution(byStage),
        byScript: distribution(byScript).map(entry => ({ ...entry, url: entriesById.get(entry.name)?.script.url ?? null })),
        byIdentity: distribution(byIdentity),
        topFunctions: distribution(byFunction).filter(entry => entry.name !== '(no owner)').slice(0, 20).map(entry => {
            const [scriptId, start] = entry.name.split(':').map(Number);
            const script = entriesById.get(scriptId)?.script;
            const matches = script ? rangesByScript.get(script).get(start) || [] : [];

            return { ...entry, scriptId, start, url: script?.url ?? null,
                functionName: matches.length === 1 && start !== 0 ? matches[0].range.name : null };
        }),
        eventScriptType: distribution(cross).map(({ name, ...values }) => {
            const [event, scriptId, type] = JSON.parse(name);

            return { event, scriptId, type, ...values };
        })
    };
}

export default async function(model) {
    const reports = [];
    const threads = new Set();

    for (const profile of model.data.profiles || []) {
        const thread = profile.thread;

        if (threads.has(thread)) {
            continue;
        }

        threads.add(thread);
        const context = { ...model.getContext(), scopeProfile: profile, originals: false, utfOnly: false, filter: null };
        const pending = new Set((thread.scripts || []).filter(entry => entry.script?.functionRanges === null).map(entry => entry.script));
        const entries = await model.query(`
            (scopeProfile().thread.scripts or [])
                .[script and (no script.originalFor or #.originals)]
                .[script.url ~= #.filter]
                .parseScriptSources()
        `, model.data, context);
        const summaries = model.query(`
            $thread: scopeProfile().thread;
            $hasEvents: $thread.compilations.size() > 0;
            $.(script.scriptSourceSummary(compilation, $hasEvents))
                .[no #.utfOnly or bytesPerChar > 1]
        `, entries, context);
        const records = thread.compilations || [];
        const recordsByScript = new Map();

        for (const record of records) {
            recordsByScript.set(record.scriptId, (recordsByScript.get(record.scriptId) || 0) + 1);
        }

        const entriesById = new Map(entries.map(entry => [entry.id, entry]));
        const rangesByScript = new Map(entries.map(entry => [entry.script, indexRanges(entry.script)]));
        const byEvent = new Map();

        const report = {
            thread: thread.name,
            pid: thread.pid,
            tid: thread.tid,
            scripts: entries.length,
            compilationRecords: records.length,
            lateParsed: 0,
            parseUnavailable: 0,
            sourceBytes: 0,
            compiledBytes: 0,
            compiledUnavailable: 0,
            unmatchedStarts: 0,
            unknownStages: [],
            violations: {},
            examples: [],
            unmatchedExamples: [],
            callFrameMismatchExamples: [],
            topScripts: []
        };

        function violation(kind, entry, details) {
            report.violations[kind] = (report.violations[kind] || 0) + 1;

            if (report.examples.length < 12) {
                report.examples.push({ kind, id: entry.id, url: entry.script.url, ...details });
            }
        }

        for (const [entryIndex, entry] of entries.entries()) {
            const { script, compilation } = entry;
            const summary = summaries[entryIndex];
            const functions = model.query('scriptSourceFunctions(#.compilation)', script, { compilation });

            report.sourceBytes += summary.byteLength || 0;
            report.compiledBytes += summary.compiledBytes || 0;
            report.compiledUnavailable += summary.compiledBytes === null ? 1 : 0;
            report.unmatchedStarts += summary.unmatched;
            report.unknownStages.push(...summary.unknownStages);
            report.topScripts.push({
                id: entry.id,
                url: script.url,
                sourceBytes: summary.byteLength,
                compiledBytes: summary.compiledBytes,
                functions: summary.functions,
                unmatched: summary.unmatched,
                states: summary.states
            });

            if (script.functionRanges === null) {
                report.parseUnavailable++;
                continue;
            }

            if (script.sourceMetrics === null || script.sourceMetrics.selfSize === null) {
                violation('metricsUnavailableAfterParsing', entry, {});
                continue;
            }

            if (pending.has(script)) {
                report.lateParsed++;
            }

            if (recordsByScript.has(entry.id) && compilation === null) {
                violation('recordsWithoutCompilation', entry, { records: recordsByScript.get(entry.id) });
            }

            if (compilation && compilation.states.length !== script.functionRanges.length + 1) {
                violation('stateRangeLength', entry, {
                    states: compilation.states.length,
                    ranges: script.functionRanges.length
                });
            }

            const ownBytes = functions.reduce((sum, item) => sum + item.ownBytes, 0);
            const stateBytes = (summary.stateSizes || []).reduce((sum, bytes) => sum + bytes, 0);

            if (summary.byteLength !== null && (ownBytes !== summary.byteLength || stateBytes !== summary.byteLength)) {
                violation('sourcePartition', entry, { ownBytes, stateBytes, sourceBytes: summary.byteLength });
            }

            if (summary.compiledBytes !== null && (summary.compiledBytes < 0 || summary.compiledBytes > summary.byteLength)) {
                violation('compiledBounds', entry, { compiledBytes: summary.compiledBytes, sourceBytes: summary.byteLength });
            }

            for (const item of functions) {
                if (item.selfSize < 0 || item.start < 0 || item.end > script.source.length || item.end < item.start) {
                    violation('functionBounds', entry, { name: item.name, start: item.start, end: item.end, selfSize: item.selfSize });
                }
            }

            const expected = new Float64Array(script.functionRanges.length + 1);
            const parents = [];

            expected[0] = script.source.length;

            for (const [index, range] of script.functionRanges.entries()) {
                while (parents.length && parents.at(-1).range.end <= range.callFrameStart) {
                    parents.pop();
                }

                const parent = parents.at(-1);
                const size = range.end - range.callFrameStart;

                if (parent && range.end > parent.range.end) {
                    violation('crossingFunctionRanges', entry, { start: range.callFrameStart, end: range.end });
                }

                expected[index + 1] += size;
                expected[parent ? parent.index + 1 : 0] -= size;
                parents.push({ index, range });
            }

            for (let index = 0; index < expected.length; index++) {
                if (functions[index]?.selfSize !== expected[index]) {
                    violation('exclusiveFunctionSize', entry, {
                        index,
                        actual: functions[index]?.selfSize,
                        expected: expected[index]
                    });
                }
            }
        }

        const frameExamples = new Set();

        for (const record of records) {
            let event = byEvent.get(record.name);

            if (!event) {
                byEvent.set(record.name, event = { name: record.name, count: 0, incomplete: 0, instant: 0, matchedFunction: 0,
                    wholeScript: 0, unresolvedScript: 0, unparsed: 0, unmatched: 0, callFrameDisagrees: 0 });
            }

            event.count++;
            event.incomplete += record.duration === null ? 1 : 0;
            event.instant += record.duration === 0 ? 1 : 0;
            const entry = entriesById.get(record.scriptId);
            const script = entry?.script;

            if (!script) {
                event.unresolvedScript++;
                continue;
            }

            if (script.functionRanges === null) {
                event.unparsed++;
                continue;
            }

            const matches = (rangesByScript.get(script).get(record.start) || []).filter(({ range }) =>
                range.end === record.end || (range.defaultConstructor && record.end === record.start)
            );

            if (record.start === 0 && record.end === script.source.length) {
                event.wholeScript++;
            } else if (matches.length === 1) {
                event.matchedFunction++;
            } else {
                event.unmatched++;

                if (report.unmatchedExamples.length < 20) {
                    report.unmatchedExamples.push({
                        event: record.name,
                        id: record.scriptId,
                        start: record.start,
                        end: record.end,
                        startMatches: (rangesByScript.get(script).get(record.start) || []).map(({ range }) => ({
                            type: range.type,
                            start: range.callFrameStart,
                            end: range.end
                        }))
                    });
                }
            }

            if (record.callFrame && (record.callFrame.script !== script || record.callFrame.start !== record.start ||
                (record.callFrame.end !== record.end && !matches.some(({ range }) => range.defaultConstructor)))) {
                event.callFrameDisagrees++;

                const key = `${record.scriptId}:${record.start}:${record.end}`;

                if (matches.length === 1 && !frameExamples.has(key) && report.callFrameMismatchExamples.length < 12) {
                    frameExamples.add(key);
                    report.callFrameMismatchExamples.push({
                        scriptId: record.scriptId, event: record.name, start: record.start, end: record.end,
                        range: matches[0].range,
                        frame: { scriptId: record.callFrame.script?.id, start: record.callFrame.start,
                            end: record.callFrame.end, name: record.callFrame.name, kind: record.callFrame.kind }
                    });
                }
            }
        }

        report.topScripts.sort((first, second) => (second.compiledBytes || 0) - (first.compiledBytes || 0));
        report.topScripts = report.topScripts.slice(0, 12);
        report.unknownStages = [...new Set(report.unknownStages)];
        report.events = [...byEvent.values()].sort((first, second) => second.count - first.count);
        report.nesting = model.query('eventNesting()', records, model.getContext());
        report.allocations = auditAllocations(model, profile, entriesById, rangesByScript);

        reports.push(report);
    }

    return { reports };
}
