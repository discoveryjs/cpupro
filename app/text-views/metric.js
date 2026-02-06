import { resolveScopeProfileLine } from '../jora/profile.js';

export default function({ textView }) {
    textView.define('metric', (el, config, data, context) => {
        const {
            value = typeof data === 'number' ? data : data?.value ?? 0,
            total = data?.total ?? 'line' // number | line | bucket | all-profiles
        } = config;
        const line = resolveScopeProfileLine(config.line, context);
        const valueWithUnit = value !== 0
            ? line.valueWithUnit(value)
            : { value: '—', unit: '' };
        const resolvedTotal = typeof total === 'number'
            ? total
            : total === 'line'
                ? line.axisTotal
                : 0; // TODO: support 'bucket' and 'all-profiles'

        el.appendText(`${valueWithUnit.value}${valueWithUnit.unit}`);

        if (resolvedTotal) {
            const fraction = 100 * value / resolvedTotal;

            if (fraction !== 0) {
                el.appendText(` (${fraction < 0.1
                    ? '<0.1%'
                    : fraction >= 99.9
                        ? Math.round(fraction) + '%'
                        : fraction.toFixed(1) + '%'})`);
            }
        }
    });
}
