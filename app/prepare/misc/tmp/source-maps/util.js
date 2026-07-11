/**
 * This is a helper function for getting values from parameter/options
 * objects.
 *
 * @param args The object we are extracting values from
 * @param name The name of the property we are getting.
 * @param defaultValue An optional value to return if the property is missing
 * from the object. If this is not specified and the property is missing, an
 * error will be thrown.
 */
export function getArg(args, name, defaultValue) {
    if (name in args) {
        return args[name];
    } else if (arguments.length === 3) {
        return defaultValue;
    }

    throw new Error('"' + name + '" is a required argument.');
}

const urlRegexp = /^(?:([\w+\-.]+):)?\/\/(?:(\w+:\w+)@)?([\w.-]*)(?::(\d+))?(.*)$/;
const dataUrlRegexp = /^data:.+\,.+$/;

export function urlParse(aUrl) {
    const match = aUrl.match(urlRegexp);

    if (!match) {
        return null;
    }

    return {
        scheme: match[1],
        auth: match[2],
        host: match[3],
        port: match[4],
        path: match[5]
    };
}

export function urlGenerate(parsedUrl) {
    let url = '';

    if (parsedUrl.scheme) {
        url += parsedUrl.scheme + ':';
    }

    url += '//';

    if (parsedUrl.auth) {
        url += parsedUrl.auth + '@';
    }

    if (parsedUrl.host) {
        url += parsedUrl.host;
    }

    if (parsedUrl.port) {
        url += ':' + parsedUrl.port;
    }

    if (parsedUrl.path) {
        url += parsedUrl.path;
    }

    return url;
}

/**
 * Normalizes a path, or the path portion of a URL:
 *
 * - Replaces consecutive slashes with one slash.
 * - Removes unnecessary '.' parts.
 * - Removes unnecessary '<dir>/..' parts.
 *
 * Based on code in the Node.js 'path' core module.
 *
 * @param {String} path The path or url to normalize.s
 */
export const normalize = (function normalize(path) {
    const url = urlParse(path);

    if (url) {
        if (!url.path) {
            return path;
        }
        path = url.path;
    }

    const isAbsolutePath = isAbsolute(path);
    // Split the path into parts between `/` characters. This is much faster than
    // using `.split(/\/+/g)`.
    const parts = [];
    let start = 0;
    let i = 0;

    while (true) {
        start = i;
        i = path.indexOf('/', start);

        if (i === -1) {
            parts.push(path.slice(start));
            break;
        } else {
            parts.push(path.slice(start, i));
            while (i < path.length && path[i] === '/') {
                i++;
            }
        }
    }

    for (let part, up = 0, i = parts.length - 1; i >= 0; i--) {
        part = parts[i];
        if (part === '.') {
            parts.splice(i, 1);
        } else if (part === '..') {
            up++;
        } else if (up > 0) {
            if (part === '') {
                // The first part is blank if the path is absolute. Trying to go
                // above the root is a no-op. Therefore we can remove all '..' parts
                // directly after the root.
                parts.splice(i + 1, up);
                up = 0;
            } else {
                parts.splice(i, 2);
                up--;
            }
        }
    }

    path = parts.join('/');

    if (path === '') {
        path = isAbsolutePath ? '/' : '.';
    }

    if (url) {
        url.path = path;
        return urlGenerate(url);
    }

    return path;
});

/**
 * Joins two paths/URLs.
 *
 * @param aRoot The root path or URL.
 * @param aPath The path or URL to be joined with the root.
 *
 * - If aPath is a URL or a data URI, aPath is returned, unless aPath is a
 *   scheme-relative URL: Then the scheme of aRoot, if any, is prepended
 *   first.
 * - Otherwise aPath is a path. If aRoot is a URL, then its path portion
 *   is updated with the result and aRoot is returned. Otherwise the result
 *   is returned.
 *   - If aPath is absolute, the result is aPath.
 *   - Otherwise the two paths are joined with a slash.
 * - Joining for example 'http://' and 'www.example.com' is also supported.
 */
export function join(aRoot, aPath) {
    if (aRoot === '') {
        aRoot = '.';
    }
    if (aPath === '') {
        aPath = '.';
    }

    const aPathUrl = urlParse(aPath);
    const aRootUrl = urlParse(aRoot);

    if (aRootUrl) {
        aRoot = aRootUrl.path || '/';
    }

    // `join(foo, '//www.example.org')`
    if (aPathUrl && !aPathUrl.scheme) {
        if (aRootUrl) {
            aPathUrl.scheme = aRootUrl.scheme;
        }
        return urlGenerate(aPathUrl);
    }

    if (aPathUrl || aPath.match(dataUrlRegexp)) {
        return aPath;
    }

    // `join('http://', 'www.example.com')`
    if (aRootUrl && !aRootUrl.host && !aRootUrl.path) {
        aRootUrl.host = aPath;
        return urlGenerate(aRootUrl);
    }

    const joined = aPath.charAt(0) === '/'
        ? aPath
        : normalize(aRoot.replace(/\/+$/, '') + '/' + aPath);

    if (aRootUrl) {
        aRootUrl.path = joined;
        return urlGenerate(aRootUrl);
    }

    return joined;
}

export function isAbsolute(aPath) {
    return aPath.charAt(0) === '/' || urlRegexp.test(aPath);
};

/**
 * Make a path relative to a URL or another path.
 *
 * @param aRoot The root path or URL.
 * @param aPath The path or URL to be made relative to aRoot.
 */
export function relative(aRoot, aPath) {
    if (aRoot === '') {
        aRoot = '.';
    }

    aRoot = aRoot.replace(/\/$/, '');

    // It is possible for the path to be above the root. In this case, simply
    // checking whether the root is a prefix of the path won't work. Instead, we
    // need to remove components from the root one by one, until either we find
    // a prefix that fits, or we run out of components to remove.
    let level = 0;
    while (aPath.indexOf(aRoot + '/') !== 0) {
        const index = aRoot.lastIndexOf('/');

        if (index < 0) {
            return aPath;
        }

        // If the only part of the root that is left is the scheme (i.e. http://,
        // file:///, etc.), one or more slashes (/), or simply nothing at all, we
        // have exhausted all components, so the path is not relative to the root.
        aRoot = aRoot.slice(0, index);
        if (aRoot.match(/^([^\/]+:\/)?\/*$/)) {
            return aPath;
        }

        ++level;
    }

    // Make sure we add a "../" for each component we removed from the root.
    return '../'.repeat(level) + aPath.substr(aRoot.length + 1);
}

/**
 * Comparator between two mappings where the original positions are compared.
 *
 * Optionally pass in `true` as `onlyCompareGenerated` to consider two
 * mappings with the same original source/line/column, but different generated
 * line and column the same. Useful when searching for a mapping with a
 * stubbed out mapping.
 */
export function compareByOriginalPositions(mappingA, mappingB, onlyCompareOriginal) {
    let cmp = strcmp(mappingA.source, mappingB.source);
    if (cmp !== 0) {
        return cmp;
    }

    cmp = mappingA.originalLine - mappingB.originalLine;
    if (cmp !== 0) {
        return cmp;
    }

    cmp = mappingA.originalColumn - mappingB.originalColumn;
    if (cmp !== 0 || onlyCompareOriginal) {
        return cmp;
    }

    cmp = mappingA.generatedColumn - mappingB.generatedColumn;
    if (cmp !== 0) {
        return cmp;
    }

    cmp = mappingA.generatedLine - mappingB.generatedLine;
    if (cmp !== 0) {
        return cmp;
    }

    return strcmp(mappingA.name, mappingB.name);
}

export function compareByOriginalPositionsNoSource(mappingA, mappingB, onlyCompareOriginal) {
    let cmp = mappingA.originalLine - mappingB.originalLine;
    if (cmp !== 0) {
        return cmp;
    }

    cmp = mappingA.originalColumn - mappingB.originalColumn;
    if (cmp !== 0 || onlyCompareOriginal) {
        return cmp;
    }

    cmp = mappingA.generatedColumn - mappingB.generatedColumn;
    if (cmp !== 0) {
        return cmp;
    }

    cmp = mappingA.generatedLine - mappingB.generatedLine;
    if (cmp !== 0) {
        return cmp;
    }

    return strcmp(mappingA.name, mappingB.name);
}

/**
 * Comparator between two mappings with deflated source and name indices where
 * the generated positions are compared.
 *
 * Optionally pass in `true` as `onlyCompareGenerated` to consider two
 * mappings with the same generated line and column, but different
 * source/name/original line and column the same. Useful when searching for a
 * mapping with a stubbed out mapping.
 */
export function compareByGeneratedPositionsDeflated(mappingA, mappingB, onlyCompareGenerated) {
    let cmp = mappingA.generatedLine - mappingB.generatedLine;
    if (cmp !== 0) {
        return cmp;
    }

    cmp = mappingA.generatedColumn - mappingB.generatedColumn;
    if (cmp !== 0 || onlyCompareGenerated) {
        return cmp;
    }

    cmp = strcmp(mappingA.source, mappingB.source);
    if (cmp !== 0) {
        return cmp;
    }

    cmp = mappingA.originalLine - mappingB.originalLine;
    if (cmp !== 0) {
        return cmp;
    }

    cmp = mappingA.originalColumn - mappingB.originalColumn;
    if (cmp !== 0) {
        return cmp;
    }

    return strcmp(mappingA.name, mappingB.name);
}

export function compareByGeneratedPositionsDeflatedNoLine(mappingA, mappingB, onlyCompareGenerated) {
    let cmp = mappingA.generatedColumn - mappingB.generatedColumn;
    if (cmp !== 0 || onlyCompareGenerated) {
        return cmp;
    }

    cmp = strcmp(mappingA.source, mappingB.source);
    if (cmp !== 0) {
        return cmp;
    }

    cmp = mappingA.originalLine - mappingB.originalLine;
    if (cmp !== 0) {
        return cmp;
    }

    cmp = mappingA.originalColumn - mappingB.originalColumn;
    if (cmp !== 0) {
        return cmp;
    }

    return strcmp(mappingA.name, mappingB.name);
}

function strcmp(str1, str2) {
    if (str1 === str2) {
        return 0;
    }

    if (str1 === null) {
        return 1; // str2 !== null
    }

    if (str2 === null) {
        return -1; // str1 !== null
    }

    if (str1 > str2) {
        return 1;
    }

    return -1;
}

/**
 * Comparator between two mappings with inflated source and name strings where
 * the generated positions are compared.
 */
export function compareByGeneratedPositionsInflated(mappingA, mappingB) {
    let cmp = mappingA.generatedLine - mappingB.generatedLine;
    if (cmp !== 0) {
        return cmp;
    }

    cmp = mappingA.generatedColumn - mappingB.generatedColumn;
    if (cmp !== 0) {
        return cmp;
    }

    cmp = strcmp(mappingA.source, mappingB.source);
    if (cmp !== 0) {
        return cmp;
    }

    cmp = mappingA.originalLine - mappingB.originalLine;
    if (cmp !== 0) {
        return cmp;
    }

    cmp = mappingA.originalColumn - mappingB.originalColumn;
    if (cmp !== 0) {
        return cmp;
    }

    return strcmp(mappingA.name, mappingB.name);
}

/**
 * Strip any JSON XSSI avoidance prefix from the string (as documented
 * in the source maps specification), and then parse the string as
 * JSON.
 */
export function parseSourceMapInput(str) {
    return JSON.parse(str);
}

/**
 * Compute the URL of a source given the the source root, the source's
 * URL, and the source map's URL.
 */
export function computeSourceURL(sourceRoot, sourceURL, sourceMapURL) {
    sourceURL = sourceURL || '';

    if (sourceRoot) {
    // This follows what Chrome does.
        if (sourceRoot[sourceRoot.length - 1] !== '/' && sourceURL[0] !== '/') {
            sourceRoot += '/';
        }

        // The spec says:
        //   Line 4: An optional source root, useful for relocating source
        //   files on a server or removing repeated values in the
        //   “sources” entry.  This value is prepended to the individual
        //   entries in the “source” field.
        sourceURL = sourceRoot + sourceURL;
    }

    // Historically, SourceMapConsumer did not take the sourceMapURL as
    // a parameter.  This mode is still somewhat supported, which is why
    // this code block is conditional.  However, it's preferable to pass
    // the source map URL to SourceMapConsumer, so that this function
    // can implement the source URL resolution algorithm as outlined in
    // the spec.  This block is basically the equivalent of:
    //    new URL(sourceURL, sourceMapURL).toString()
    // ... except it avoids using URL, which wasn't available in the
    // older releases of node still supported by this library.
    //
    // The spec says:
    //   If the sources are not absolute URLs after prepending of the
    //   “sourceRoot”, the sources are resolved relative to the
    //   SourceMap (like resolving script src in a html document).
    if (sourceMapURL) {
        const parsed = urlParse(sourceMapURL);

        if (!parsed) {
            throw new Error('sourceMapURL could not be parsed');
        }

        if (parsed.path) {
            // Strip the last path component, but keep the "/".
            const index = parsed.path.lastIndexOf('/');
            if (index >= 0) {
                parsed.path = parsed.path.substring(0, index + 1);
            }
        }

        sourceURL = join(urlGenerate(parsed), sourceURL);
    }

    return normalize(sourceURL);
}
