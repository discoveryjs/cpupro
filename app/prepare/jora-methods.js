import { typeColor, typeColorComponents, typeOrder } from './const.js';
import { CallTree } from './call-tree.js';

export default {
    order(value) {
        return typeOrder[value] || 100;
    },
    color(value, comp) {
        const dict = comp ? typeColorComponents : typeColor;
        return dict[value] || dict.unknown;
    },
    totalPercent(value) {
        const totalTime = (this.context.context || this.context).data.totalTime; // the method can be invoked in struct annotation context
        const percent = 100 * value / totalTime;
        return percent >= 0.1 ? percent.toFixed(2) + '%' : '<0.1%';
    },
    duration(value) {
        const totalTime = (this.context.context || this.context).data.totalTime; // the method can be invoked in struct annotation context
        const percent = 100 * value / totalTime;
        return (value / 1000).toFixed(1) + 'ms' + (percent >= 0.01 ? ' / ' + percent.toFixed(2) + '%' : '');
    },
    ms(value) {
        return (value / 1000).toFixed(1) + 'ms';
    },
    select(tree, type, ...args) {
        if (tree instanceof CallTree) {
            let iterator;

            switch (type) {
                case 'nodes':
                    iterator = tree.selectNodes(...args);
                    break;
                case 'children':
                    iterator = tree.children(...args);
                    break;
                case 'ancestors':
                    iterator = tree.ancestors(...args);
                    break;
            }

            if (iterator !== undefined) {
                return [...tree.map(iterator)];
            }
        }
    },
    binCalls(_, tree, test, n = 500) {
        const { samples, timeDeltas, totalTime } = this.context.data;
        const { dictionary, nodes, mapToIndex } = tree;
        const mask = new Uint8Array(tree.dictionary.length);
        const bins = new Float64Array(n);
        const step = totalTime / n;
        let end = step;
        let binIdx = 0;

        for (let i = 0; i < mask.length; i++) {
            const accept = typeof test === 'function'
                ? test(dictionary[i])
                : test === dictionary[i];
            if (accept) {
                mask[i] = 1;
            }
        }

        const x = samples.length;
        for (let i = 0, offset = 0; i < x; i++) {
            const accept = mask[nodes[mapToIndex[samples[i]]]];
            const delta = timeDeltas[i];

            if (offset + delta < end) {
                if (accept) {
                    bins[binIdx] += delta;
                }
            } else {
                if (accept) {
                    const dx = end - offset;
                    let x = delta - dx;
                    let i = 1;
                    while (x > step) {
                        bins[binIdx + i] = step;
                        i++;
                        x -= step;
                    }

                    bins[binIdx] += dx;
                    bins[binIdx + i] = x;
                }

                while (offset + delta > end) {
                    binIdx += 1;
                    end += step;
                }
            }

            offset += delta;
        }

        // let sum = 0;
        // for (let i = 0; i < bins.length; i++) {
        //     sum += bins[i];
        //     // bins[i] /= step;
        // }
        // bins[0] = step;

        return Array.from(bins);
    },
    groupByCallSiteRef: `
        group(=>callFrame.ref).({
            grouped: value,
            ...value[],
            children: value.children,
            selfTime: value.sum(=>selfTime),
            totalTime: value | $ + ..children | .sum(=>selfTime),
        })
    `
};
