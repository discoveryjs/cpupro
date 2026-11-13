import { SetAttributeFilter, type PreparedAttributeFilter } from '../computations/attribute-filter.js';
import type { PopulationFilter } from '../computations/population-filter.js';
import type { ProfileLine } from './types.js';
import type { FilterComputation } from './filters/types.js';
import { createCategoryFilter } from './filters/category.js';
import { createAttributeFilter } from './filters/attribute.js';

const breakdownFilterFactories = {
    categories: createCategoryFilter
};

type PreparedComputation = FilterComputation & {
    targets: PopulationFilter[];
    revision?: number;
    result?: PreparedAttributeFilter;
};

export function prepareLineFilters(line: ProfileLine) {
    const { filters, breakdowns, attributes } = line;
    // Histogram windows apply the same prepared filters as viewports
    const targets = [...new Set(breakdowns.flatMap(breakdown => [breakdown.populationViewport.filter, breakdown.populationWindow.filter]))];
    const computations: PreparedComputation[] = [];
    const include = (computation: FilterComputation | null, targets: PopulationFilter[]) => {
        if (!computation) {
            return;
        }

        const candidate = computation.settings;
        const settings = filters.get(candidate.key);

        if (settings instanceof SetAttributeFilter) {
            settings.addOptions(candidate.options);
            computation.settings = settings;
        } else {
            filters.add(candidate);
        }

        // Results read the values of their computation, which a filter of an attribute reads from the attribute as
        // a line keys them by signatures (see createAttributeFilter)
        computations.push(Object.assign(computation, { targets }));
    };

    filters.batch(() => {
        const populationBreakdowns = new Map<PopulationFilter, ProfileLine['breakdowns']>();

        for (const breakdown of breakdowns) {
            const target = breakdown.populationViewport.filter;
            const sources = populationBreakdowns.get(target);

            if (sources) {
                sources.push(breakdown);
            } else {
                populationBreakdowns.set(target, [breakdown]);
            }
        }

        for (const [target, sources] of populationBreakdowns) {
            for (const createFilter of Object.values(breakdownFilterFactories)) {
                include(createFilter(sources), [target, sources[0].populationWindow.filter]);
            }
        }

        for (const attribute of attributes) {
            include(createAttributeFilter(attribute, line.values.length), targets);
        }
    });

    const update = () => {
        for (const computation of computations) {
            const { settings, domain, size } = computation;

            if (computation.revision !== settings.revision) {
                computation.result = {
                    key: settings.key,
                    domain,
                    size,
                    get values() {
                        return computation.values;
                    },
                    accepts: settings.active ? computation.compile(settings) : null
                };
                computation.revision = settings.revision;
            }
        }

        for (const target of targets) {
            target.batch(() => {
                for (const computation of computations) {
                    if (computation.targets.includes(target)) {
                        if (filters.get(computation.settings.key) === computation.settings) {
                            target.set(computation.result!);
                        } else {
                            target.remove(computation.settings.key);
                        }
                    }
                }
            });
        }
    };

    update();

    return filters.subscribe(update);
}
