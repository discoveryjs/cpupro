import type { PopulationFiltered } from '../../app/prepare/computations/population.js';

// An event filter accepting every event over values no event class classifies: the population and those derived
// from it aggregate events rather than records
export function setEventPass(population: PopulationFiltered) {
    population.filter.set({
        key: 'event pass',
        domain: 'event',
        size: population.population.values.length,
        values: new Uint8Array(population.population.values.length),
        accepts: Uint8Array.of(1)
    });
}
