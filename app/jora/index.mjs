import { allocTimespan, typeColor, typeColorComponents, typeOrder, vmFunctionStateTierHotness } from '../prepare/const.js';
import { methods as binMethods } from './bin.js';
import { methods as callTreeMethods, makeSamplesMask } from './call-tree.js';
import { methods as disassembleMethods } from './disassemble.js';
import { methods as positionTableMethods } from './position-table.js';
import { methods as samplesMethods } from './samples.js';
import { methods as sourceMethods } from './source.js';
import { formatMicrosecondsTime } from '../prepare/time-utils.js';

const sessionColorComponents = new Map();
const sessionColor = new Map();
const abbr = {
    Ignition: 'Ig',
    Sparkplug: 'Sp',
    Maglev: 'Ml',
    Turboprop: 'Tp',
    Turbofan: 'Tf',
    Turboshaft: 'Ts',
    Unknown: '??'
};

function shortNum(current, units, base = 1000) {
    let unitIdx = 0;

    while (current > base && unitIdx < units.length - 1) {
        current /= base;
        unitIdx++;
    }

    const value = unitIdx === 0
        ? current
        : current < 100
            ? current.toFixed(1).replace(/\.0/, '')
            : Math.round(current);

    return value + units[unitIdx];
}

const methods = {
    ...binMethods,
    ...callTreeMethods,
    ...disassembleMethods,
    ...positionTableMethods,
    ...samplesMethods,
    ...sourceMethods,
    order(value) {
        return typeOrder[value] || 100;
    },
    color(value, comp) {
        const dict = comp ? typeColorComponents : typeColor;
        return dict[value] || dict.unknown;
    },
    // FIXME: temporary solution
    colorRand(value, comp) {
        const dict = comp ? typeColorComponents : typeColor;
        const map = comp ? sessionColorComponents : sessionColor;

        if (!map.has(value)) {
            const keys = Object.keys(dict);
            map.set(value, dict[keys[Math.floor(Math.random() * keys.length)]]);
        }

        return map.get(value);
    },
    abbr(value) {
        return abbr[value] || value;
    },
    hotness(tier) {
        return vmFunctionStateTierHotness[tier] || 'unknown';
    },
    toFixed(value, prec = 2) {
        return Number(value).toFixed(prec);
    },
    percent(value, prec = 2) {
        return (100 * value).toFixed(prec) + '%';
    },
    totalPercent(value, prec = 2) {
        const totalTime = (this.context.context || this.context)?.data?.totalTime; // the method can be invoked in struct annotation context
        const percent = 100 * value / totalTime;
        const min = 1 / Math.pow(10, prec || 1);
        return percent >= min ? percent.toFixed(prec || 1) + '%' : percent !== 0 ? '<' + min + '%' : '0%';
    },
    duration(value) {
        const totalTime = (this.context.context || this.context)?.data?.totalTime; // the method can be invoked in struct annotation context
        const percent = 100 * value / totalTime;
        return (value / 1000).toFixed(1) + 'ms' + (percent >= 0.01 ? ' / ' + percent.toFixed(2) + '%' : '');
    },
    ms(value) {
        return (value / 1000).toFixed(1) + 'ms';
    },
    kb(value) {
        return (value / 1000).toFixed(1) + 'Kb';
    },
    unit(value, unit = this.context.currentProfile?.type) {
        return (value / 1000).toFixed(1) + (unit === 'memory' ? 'Kb' : 'ms');
    },
    bytes(current, bytes = 'b', base = 1000) {
        return shortNum(current, [bytes || '', 'Kb', 'Mb', 'Gb'], base);
    },
    shortNum(current) {
        return shortNum(current, ['', 'K', 'M', 'G']);
    },
    formatMicrosecondsTime,
    formatMicrosecondsTimeFixed(value, duration) {
        return formatMicrosecondsTime(value, duration, true);
    },
    zip(left, leftValue = value => value, right, rightValue = value => value) {
        const map = new Map(left.map(element => [leftValue(element), { left: element, right: null }]));

        for (const element of right) {
            const entry = map.get(rightValue(element));

            if (entry !== undefined) {
                entry.right = element;
            }
        }

        return [...map.values()];
    },
    getEntry(source, subject) {
        if (typeof source?.getEntry === 'function') {
            return source.getEntry(subject);
        }
    },
    allocationsMatrix(tree, sampleTimings, subject, profile = this.context.data.currentProfile) {
        const { _memoryGc, _memoryType, _memoryTypeNames: allocTypes } = profile;
        const { samples, timeDeltas } = sampleTimings;
        const timespanCount = allocTimespan.length;
        const typeCount = allocTypes.length;
        const counts = new Uint32Array(timespanCount * typeCount);
        const sums = new Uint32Array(timespanCount * typeCount);
        const mins = new Uint32Array(timespanCount * typeCount);
        const maxs = new Uint32Array(timespanCount * typeCount);
        const samplesMask = makeSamplesMask(tree, subject);
        const result = [];

        for (let i = 0; i < samples.length; i++) {
            if (samplesMask[samples[i]] !== 0) {
                const value = timeDeltas[i];

                if (value !== 0) {
                    const index = _memoryType[i] * timespanCount + _memoryGc[i];

                    counts[index]++;
                    sums[index] += value;
                    mins[index] = mins[index] ? Math.min(mins[index], value) : value;
                    maxs[index] = Math.max(maxs[index], value);
                }
            }
        }

        for (let i = 0; i < allocTypes.length; i++) {
            const entry = {
                type: allocTypes[i],
                total: {
                    count: 0,
                    sum: 0,
                    min: Infinity,
                    max: 0
                }
            };

            for (let j = 0; j < allocTimespan.length; j++) {
                const index = i * timespanCount + j;
                const count = counts[index];

                if (count > 0) {
                    entry.total.count += counts[index];
                    entry.total.sum += sums[index];
                    entry.total.min = Math.min(entry.total.min, mins[index]);
                    entry.total.max = Math.max(entry.total.max, maxs[index]);
                }

                entry[allocTimespan[j]] = {
                    count: counts[index],
                    sum: sums[index],
                    min: mins[index],
                    max: maxs[index]
                };
            }

            if (entry.total.count) {
                result.push(entry);
            }
        }
        return result;
    }
};

export default methods;

// import { trackExecutionTime } from './jora-methods-bench.js';
// TIMINGS && trackExecutionTime(methods, ['select', 'selectBy', 'subtreeSamples', 'nestedTimings', 'binCalls']);
