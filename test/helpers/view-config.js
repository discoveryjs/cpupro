// Configs of views are reached by their identities (a view, name or class name) rather than by their positions
// in content arrays. Returns the first object in depth-first order whose values equal all values of `match`
export function findView(config, match) {
    const found = findViews(config, match);

    if (found.length === 0) {
        throw new Error('No view config matches ' + JSON.stringify(match));
    }

    return found[0];
}

// Returns all objects matching `match`, in depth-first order
export function findViews(config, match, found = []) {
    if (config === null || typeof config !== 'object') {
        return found;
    }

    if (!Array.isArray(config)) {
        let matches = true;

        for (const key in match) {
            if (config[key] !== match[key]) {
                matches = false;
                break;
            }
        }

        if (matches) {
            found.push(config);
        }
    }

    const values = Object.values(config);

    for (let i = 0; i < values.length; i++) {
        findViews(values[i], match, found);
    }

    return found;
}

// A property of a view holds a query after "=" (`'=total.formatValue()'`); returns the query compiled by `query`,
// a Jora setup of the test
export function propertyQuery(query, value) {
    return query(value.slice(1));
}

// A content of a view holds a query after the name of the view (`'text:label'`); returns the query compiled by `query`
export function contentQuery(query, content) {
    return query(content.slice(content.indexOf(':') + 1));
}

// A column of a table view by its header, a text or a config with the text
export function findColumn(table, header) {
    for (let i = 0; i < table.cols.length; i++) {
        const column = table.cols[i];

        if (column.header === header || column.header.text === header) {
            return column;
        }
    }

    throw new Error('No column ' + header);
}

// Content queries of views (`text:…`, `metric:…`) have no identity of their own, they are found by their beginning:
// returns the first string starting with `prefix`, in depth-first order
export function findContent(config, prefix) {
    const found = findContents(config, prefix);

    if (found.length === 0) {
        throw new Error('No content starts with ' + prefix);
    }

    return found[0];
}

function findContents(config, prefix, found = []) {
    if (typeof config === 'string') {
        if (config.startsWith(prefix)) {
            found.push(config);
        }
    } else if (config !== null && typeof config === 'object') {
        const values = Object.values(config);

        for (let i = 0; i < values.length; i++) {
            findContents(values[i], prefix, found);
        }
    }

    return found;
}

// The context a `line-metrics-value` view gives its content: the value computed as the view does it,
// evaluated with the result of `valueContext` when it's given, shared as `#.<name>.value`
export function lineMetricsValueContext(config, data, context, query) {
    const valueContext = config.valueContext ? query(config.valueContext)(data, context) : context;

    return {
        ...context,
        [config.name]: { value: query(config.value)(data, valueContext) }
    };
}
