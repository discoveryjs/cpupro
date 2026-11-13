import { deriveScope, missingScopeElement } from '../jora/scope.js';

const choiceText = {
    session: 'name or "Untitled session"',
    process: 'name or `Process ${pid}`',
    thread: 'name or `Thread ${tid}`',
    profile: 'name or "Untitled profile"',
    line: 'type',
    breakdown: 'kind',
    scale: 'kind'
};

// Renders its content with a scope where the required element and its anchors are selected. An element missing
// in the scope of the context is chosen here: the choice is kept in the context of the view and its content
// follows it, a single choice is taken when nothing was requested for the element. Without choices the view
// tells that the data has none
discovery.view.define('scope', function(el, config, data, context) {
    const { requires, content } = config;
    let scope = context.scope;
    const render = () => {
        const missing = missingScopeElement(scope, requires);

        if (missing === null) {
            // Migration adapter: views and Jora methods resolving the scope through the flat fields
            // (resolveScope* of jora/profile.ts and their callers) get the scope of the view in them;
            // it goes once they read `#.scope`
            return this.render(el, content, data, {
                ...context,
                scope,
                scopeProfile: scope.profile,
                scopeLine: scope.line,
                scopeBreakdown: scope.breakdown
            });
        }

        const { element, choices } = missing;
        const request = scope.requests[element] ?? null;

        if (choices.length === 0) {
            return this.render(el, `alert-warning:"No ${element} to show"`, data, context);
        }

        if (choices.length === 1 && request === null) {
            return choose(choices[0]);
        }

        return this.render(el, [
            {
                view: 'block',
                className: 'scope-choice-message',
                content: request !== null
                    ? `text:"No ${request} ${element}, choose a ${element}"`
                    : `text:"Choose a ${element}"`
            },
            {
                view: 'select',
                placeholder: `Choose a ${element}`,
                text: choiceText[element],
                onChange: choose
            }
        ], choices, context);
    };
    const choose = (choice) => {
        const { element } = missingScopeElement(scope, requires);

        scope = deriveScope(scope, { [element]: choice });
        el.replaceChildren();

        return render();
    };

    return render();
});
