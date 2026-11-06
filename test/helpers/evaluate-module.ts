import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Evaluates an app module as a script in a fresh context. Its import declarations are removed,
// so the imported bindings, as well as browser and Discovery globals, are supplied via `globals`.
// Returns the value of `binding` when it is given, otherwise the value of the module's last statement.
export function evaluateModule(url: URL, globals: object, binding?: string) {
    let source = readFileSync(url, 'utf8').replace(/^import .*;\n/gm, '');

    if (binding !== undefined) {
        source += '\n' + binding + ';';
    }

    return runInNewContext(source, globals);
}
