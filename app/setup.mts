import { ModelOptions } from '@discoveryjs/discovery';
import joraQueryHelpers from './jora/index.mjs';
import prepare from './setup-prepare.mjs';
import { CpuProCallFrame, CpuProCallFramePosition, CpuProCategory, CpuProModule, CpuProPackage, CpuProScript, CpuProCallFrameCodes } from './prepare/types.js';

export default (function({ defineObjectMarker, addQueryMethods, setPrepare }) {
    defineObjectMarker<CpuProCallFrame>('call-frame', { ref: 'id', title: 'name', page: 'call-frame' });
    defineObjectMarker<CpuProCallFramePosition>('call-frame-position', { /* ref: 'id', */ title: 'scriptOffset' });
    defineObjectMarker<CpuProModule>('module', { ref: 'id', title: (module) => module.name || module.path, page: 'module' });
    defineObjectMarker<CpuProPackage>('package', { ref: 'id', title: 'name', page: 'package' });
    defineObjectMarker<CpuProCategory>('category', { ref: 'name', title: 'name', page: 'category' });
    defineObjectMarker<CpuProScript>('script', { ref: 'id', title: 'url' });
    defineObjectMarker<CpuProCallFrameCodes>('call-frame-codes', { /* ref: 'id', */ title: fn => fn.callFrame.name });

    // extend jora's queries with custom methods
    addQueryMethods(joraQueryHelpers);

    // FIXME: annotations for struct view
    // addValueAnnotation('#.key in ["selfTime", "nestedTime", "totalTime"] and $ and { text: duration() }');

    setPrepare(prepare);
} satisfies ModelOptions['setup']);
