export default function({ textView }) {
    textView.define('duration', (el, config, data, context) => {
        const { time, total } = data;
        const profileType = context.data?.currentProfile?.type || 'time';
        el.appendText(`${(time / 1000).toFixed(1)}${profileType === 'memory' ? 'Kb' : 'ms'} (${(100 * time / total).toFixed(1)}%)`);
    });
}
