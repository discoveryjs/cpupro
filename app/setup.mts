import { ModelOptions } from '@discoveryjs/discovery';
import joraQueryHelpers from './prepare/jora-methods.mjs';
import prepare from './setup-prepare.mjs';
import { CpuProCallFrame, CpuProCategory, CpuProFunction, CpuProModule, CpuProPackage, CpuProScript, CpuProScriptFunction } from './prepare/types.js';

export default (function({ defineObjectMarker, addQueryHelpers, setPrepare }) {
    defineObjectMarker<CpuProCallFrame>('callFrame', { ref: 'id', title: 'name' });
    defineObjectMarker<CpuProFunction>('function', { ref: 'id', title: 'name', page: 'function' });
    defineObjectMarker<CpuProPackage>('package', { ref: 'id', title: 'name', page: 'package' });
    defineObjectMarker<CpuProModule>('module', { ref: 'id', title: (module) => module.name || module.path, page: 'module' });
    defineObjectMarker<CpuProCategory>('category', { ref: 'name', title: 'name', page: 'category' });
    defineObjectMarker<CpuProScript>('script', { ref: 'id', title: 'url' });
    defineObjectMarker<CpuProScriptFunction>('script-function', { ref: 'id', title: fn => fn.name || fn.function?.name || '(anonymous fn#' + fn.id + ')' });

    // extend jora's queries with custom methods
    addQueryHelpers(joraQueryHelpers);

    // FIXME: annotations for struct view
    // addValueAnnotation('#.key in ["selfTime", "nestedTime", "totalTime"] and $ and { text: duration() }');

    setPrepare(prepare);
} satisfies ModelOptions['setup']);
