import type { ProfileLine } from './types.js';
import type { PopulationFiltered } from '../computations/population.js';
import { RangeView } from '../computations/range.js';

export function applyRangeToPopulation(view: RangeView, filtered: PopulationFiltered) {
    // One-way migration adapter. Retire when derived populations consume scope coverage directly.
    // Only O(interval count) descriptors are created; the existing values/workspace arrays are reused.
    const update = () => filtered.setRanges(view.ranges === null ? null : view.coverage);
    const unsubscribe = view.subscribe(update);

    update();

    return unsubscribe;
}

export function prepareLineRange({ range, breakdowns }: ProfileLine) {
    const populations = new Set<PopulationFiltered>();
    const subscriptions: (() => void)[] = [];

    // Original/source-mapped breakdowns share an executor; subscribe once per distinct population workspace.
    for (const { populationFiltered } of breakdowns) {
        if (populations.has(populationFiltered)) {
            continue;
        }

        populations.add(populationFiltered);

        const view = new RangeView(range.selection, range.frame, {
            start: 0,
            end: populationFiltered.population.cumulativeEnd
        });

        subscriptions.push(applyRangeToPopulation(view, populationFiltered));
    }

    return () => {
        for (const unsubscribe of subscriptions) {
            unsubscribe();
        }
    };
}
