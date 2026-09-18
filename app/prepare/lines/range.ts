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

export function prepareLineRange({ range, viewport, breakdowns }: ProfileLine) {
    const populations = new Set<PopulationFiltered>();
    const subscriptions: (() => void)[] = [];

    // Original/source-mapped breakdowns share an executor; subscribe once per distinct population workspace.
    for (const { populationFiltered, populationViewport } of breakdowns) {
        for (const [scope, population] of [[viewport, populationViewport], [range, populationFiltered]] as const) {
            if (populations.has(population)) {
                continue;
            }

            populations.add(population);

            const view = new RangeView(scope.selection, scope.frame, {
                start: 0,
                end: population.population.cumulativeEnd
            });

            subscriptions.push(applyRangeToPopulation(view, population));
        }
    }

    return () => {
        for (const unsubscribe of subscriptions) {
            unsubscribe();
        }
    };
}
