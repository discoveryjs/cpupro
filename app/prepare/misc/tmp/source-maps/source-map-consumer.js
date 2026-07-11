import { search } from './binary-search.js';
import { decode } from './base64-vlq.js';
import {
    parseSourceMapInput,
    computeSourceURL,
    getArg,
    normalize,
    isAbsolute,
    relative,
    urlParse
} from './util.js';

function countMappings(input) {
    let mappingsCount = 0;

    for (let i = 0, count = true; i < input.length; i++) {
        switch (input[i]) {
            case 44: /* , */
            case 59: /* ; */
                count = true;
                break;
            default: if (count) {
                mappingsCount++;
                count = false;
            }
        }
    }

    return mappingsCount;
}

/**
 * A SourceMapConsumer instance represents a parsed source map which we can
 * query for information about the original file positions by giving it a file
 * position in the generated source.
 *
 * The first parameter is the raw source map (either as a JSON string, or
 * already parsed to an object). According to the spec, source maps have the
 * following attributes:
 *
 *   - version: Which version of the source map spec this map is following.
 *   - sources: An array of URLs to the original source files.
 *   - names: An array of identifiers which can be referrenced by individual mappings.
 *   - sourceRoot: Optional. The URL root from which all sources are relative.
 *   - sourcesContent: Optional. An array of contents of the original source files.
 *   - mappings: A string of base64 VLQs which contain the actual mappings.
 *   - file: Optional. The generated file this source map is associated with.
 *
 * Here is an example source map, taken from the source map spec[0]:
 *
 *     {
 *       version : 3,
 *       file: "out.js",
 *       sourceRoot : "",
 *       sources: ["foo.js", "bar.js"],
 *       names: ["src", "maps", "are", "fun"],
 *       mappings: "AA,AB;;ABCDE;"
 *     }
 *
 * The second parameter, if given, is a string whose value is the URL
 * at which the source map was found.  This URL is used to compute the
 * sources array.
 *
 * [0]: https://docs.google.com/document/d/1U1RGAehQwRypUTovF1KRlpiOFze0b-_2gc6fAH0KY0k/edit?pli=1#
 */
export class SourceMapConsumer {
    constructor(sourceMap, sourceMapURL) {
        this._version = 3;

        if (typeof sourceMap === 'string') {
            sourceMap = parseSourceMapInput(sourceMap);
        }

        const version = getArg(sourceMap, 'version');
        let sources = getArg(sourceMap, 'sources', []).slice();
        let sourceRoot = getArg(sourceMap, 'sourceRoot', null);
        const sourcesContent = getArg(sourceMap, 'sourcesContent', null);
        // Sass 3.3 leaves out the 'names' array, so we deviate from the spec (which
        // requires the array) to play nice here.
        const names = getArg(sourceMap, 'names', []).slice();
        const mappings = getArg(sourceMap, 'mappings');
        const file = getArg(sourceMap, 'file', null);

        // Once again, Sass deviates from the spec and supplies the version as a
        // string rather than a number, so we use loose equality checking here.
        if (version != this._version) {
            throw new Error('Unsupported version: ' + version);
        }

        if (sourceRoot) {
            sourceRoot = normalize(sourceRoot);
        }

        sources = sources
            .map(String)
            // Some source maps produce relative source paths like "./foo.js" instead of
            // "foo.js".  Normalize these first so that future comparisons will succeed.
            // See bugzil.la/1090768.
            .map(normalize)
            // Always ensure that absolute sources are internally stored relative to
            // the source root, if the source root is absolute. Not doing this would
            // be particularly problematic when the source root is a prefix of the
            // source (valid, but why??). See github issue #199 and bugzil.la/1188982.
            .map((source) =>
                sourceRoot && isAbsolute(sourceRoot) && isAbsolute(source)
                    ? relative(sourceRoot, source)
                    : source
            );

        // Pass `true` below to allow duplicate names and sources. While source maps
        // are intended to be compressed and deduplicated, the TypeScript compiler
        // sometimes generates source maps with duplicates in them. See Github issue
        // #72 and bugzil.la/889492.
        this._names = Object.assign(names, {
            toArray() {
                return names;
            },
            at(index) {
                return names[index];
            }
        });
        this._sources = sources;

        this._absoluteSources = sources.reduce(
            (map, source, index) => map.set(computeSourceURL(sourceRoot, source, sourceMapURL), index),
            new Map()
        );

        this.sourceRoot = sourceRoot;
        this.sourcesContent = sourcesContent;
        this._mappings = mappings;
        this._sourceMapURL = sourceMapURL;
        this.file = file;

        this.__mappings = null;
        this.__generatedMappings = null;
        this.__originalMappings = null;
    }

    /**
     * Utility function to find the index of a source. Returns -1 if not found.
     */
    _findSourceIndex(source) {
        let relativeSource = source;

        if (this.sourceRoot != null) {
            relativeSource = relative(this.sourceRoot, relativeSource);
        }

        if (this._sources.has(relativeSource)) {
            return this._sources.indexOf(relativeSource);
        }

        // Maybe source is an absolute URL as returned by |sources|. In
        // this case we can't simply undo the transform.
        const index = this._absoluteSources.get(source);
        return index === undefined ? -1 : index;
    }

    get sources() {
        return [...this._absoluteSources.keys()];
    }

    /**
     * Return true if the map has the source content for every source in the map
     */
    hasContentsOfAllSources() {
        if (!this.sourcesContent) {
            return false;
        }

        return this.sourcesContent.length >= this._sources.size() &&
            this.sourcesContent.every((sc) => typeof sc === 'string');
    }

    sourceContentFor(source, nullOnMissing) {
        if (!this.sourcesContent) {
            return null;
        }

        const index = this._findSourceIndex(source);
        if (index >= 0) {
            return this.sourcesContent[index];
        }

        let relativeSource = source;
        let url = null;

        if (this.sourceRoot != null) {
            relativeSource = relative(this.sourceRoot, relativeSource);
            url = urlParse(this.sourceRoot);
        }

        if (this.sourceRoot != null && url) {
            // XXX: file:// URIs and absolute paths lead to unexpected behavior for
            // many users. We can help them out when they expect file:// URIs to
            // behave like it would if they were running a local HTTP server. See
            // https://bugzilla.mozilla.org/show_bug.cgi?id=885597.
            const fileUriAbsPath = relativeSource.replace(/^file:\/\//, '');
            if (url.scheme == 'file' && this._sources.has(fileUriAbsPath)) {
                return this.sourcesContent[this._sources.indexOf(fileUriAbsPath)];
            }

            if ((!url.path || url.path == '/') && this._sources.has('/' + relativeSource)) {
                return this.sourcesContent[this._sources.indexOf('/' + relativeSource)];
            }
        }

        // This function is used recursively from
        // IndexedSourceMapConsumer.prototype.sourceContentFor. In that case, we
        // don't want to throw if we can't find the source - we just want to
        // return null, so we provide a flag to exit gracefully.
        if (nullOnMissing) {
            return null;
        }

        throw new Error('"' + relativeSource + '" is not in the SourceMap.');
    }

    get mappings() {
        if (!this.__mappings) {
            this._parseMappings(this._mappings, this.sourceRoot);
        }

        return this.__mappings;
    }

    get _generatedMappings() {
        if (!this.__generatedMappings) {
            this._parseMappings(this._mappings, this.sourceRoot);
        }

        return this.__generatedMappings;
    }

    get _originalMappings() {
        if (!this.__originalMappings) {
            const t = Date.now();
            const mappingSize = 6;
            const mappings = this.mappings;
            const originalMappings = Array.from({ length: this._sources.length }, () => []);

            for (let i = 0; i < mappings.length; i += mappingSize) {
                const source = mappings[i + 2] - 1;
                if (source !== -1) {
                    originalMappings[source].push(i);
                }
            }

            const sortByOriginalPos = (a, b) => (
                mappings[a + 3] - mappings[b + 3] || // originalLine
                mappings[a + 4] - mappings[b + 4] || // originalColumn
                mappings[a + 0] - mappings[b + 0] || // generatedLine
                mappings[a + 1] - mappings[b + 1]    // generatedColumn
            );

            for (const sourceMappings of originalMappings) {
                sourceMappings.sort(sortByOriginalPos);
                // sourceMappings.forEach((x, idx) => {
                //   console.log(this.getMapping(x));
                //   if (idx === 100) process.exit();
                // })
            }

            this.__originalMappings = originalMappings;
            console.log(Date.now() - t);
        }

        return this.__originalMappings;
    }

    _parseMappings(str) {
        // str = Buffer.from(str, 'latin1');
        str = new TextEncoder().encode(str);
        let mappingsCount = countMappings(str);

        let generatedLine = 1;
        let prevGeneratedColumn = 0;

        const MAPPING_SIZE = 6;
        const mapping = new Uint32Array(MAPPING_SIZE);
        mapping[2] = 1; // 0 stands for null
        mapping[3] = 1;
        mapping[5] = 1; // 0 stands for null

        const mappings = new Uint32Array(mappingsCount * MAPPING_SIZE);
        const generatedMappings = new Uint32Array(mappingsCount);
        let mappingIndex = 0;
        let mappingOffset = 0;
        let needSorting = false;

        for (let i = 0; i < str.length;) {
            switch (str[i]) {
                case 44: // ,
                    i++;
                    break;

                case 59: // ;
                    mapping[1] = prevGeneratedColumn = 0;
                    generatedLine++;
                    i++;
                    break;

                default: {
                    let fieldCount = 2;
                    i += decode(str, i, mapping, 1);
                    while (true) {
                        const consumed = decode(str, i, mapping, fieldCount);

                        if (consumed === 0) {
                            break;
                        }

                        i += consumed;
                        fieldCount++;
                    }

                    // if next mapping is with a lower column then line mappings are unsorted
                    if (prevGeneratedColumn > mapping[1]) {
                        needSorting = true;
                    }

                    // Generated line
                    mappings[mappingOffset] = generatedLine;

                    // Generated column
                    mappings[mappingOffset + 1] = prevGeneratedColumn = mapping[1];

                    switch (fieldCount) {
                        case 3:
                            throw new Error('Found a source, but no line and column');
                        case 4:
                            throw new Error('Found a source and line, but no column');
                        case 6:
                            // Original name
                            mappings[mappingOffset + 5] = mapping[5];
                        case 5:
                            // Original source
                            mappings[mappingOffset + 2] = mapping[2];

                            // Original line
                            mappings[mappingOffset + 3] = mapping[3];

                            // Original column
                            mappings[mappingOffset + 4] = mapping[4];
                    }

                    generatedMappings[mappingIndex] = mappingOffset;

                    mappingIndex++;
                    mappingOffset += MAPPING_SIZE;
                }
            }
        }

        if (needSorting) {
            // TBD
        }

        this.__mappings = mappings;// .slice(0, mappingOffset);
        this.__generatedMappings = generatedMappings;
        this._mappings = null;
    }

    getMapping(index) {
        this._generatedMappings;
        const mappings = this.__mappings;
        const source = mappings[index + 2];
        const name = mappings[index + 5];

        return {
            generatedLine: mappings[index],
            generatedColumn: mappings[index + 1],
            source: source === 0 ? null : this._sources[source - 1],
            originalLine: mappings[index + 3],
            originalColumn: mappings[index + 4],
            name: name === 0 ? null : this._names[name - 1]
        };
    }

    /**
     * Returns the original source, line, and column information for the generated
     * source's line and column positions provided
     */
    originalPositionFor(args) {
        const generatedLine = getArg(args, 'line');
        const generatedColumn = getArg(args, 'column');
        const mappingIndexes = this._generatedMappings;
        const mappings = this.__mappings;

        const index = search(
            mappings,
            mappingIndexes,
            (mappings, mappingOffset) => (
                generatedLine - mappings[mappingOffset] ||
                generatedColumn - mappings[mappingOffset + 1]
            ),
            args.bias === 2 ? 2 : 1
        );

        if (index >= 0) {
            const mappingOffset = this._generatedMappings[index];

            if (mappings[mappingOffset] === generatedLine) {
                let sourceIndex = mappings[mappingOffset + 2] - 1;
                const source = sourceIndex !== -1
                    ? this._sources[sourceIndex] ?? null
                    : null;

                let nameIndex = mappings[mappingOffset + 5] - 1;
                const name = nameIndex !== -1
                    ? this._names[nameIndex] ?? null
                    : null;

                return {
                    source,
                    line: source !== null ? mappings[mappingOffset + 3] : null,
                    column: source !== null ? mappings[mappingOffset + 4] : null,
                    name
                };
            }
        }

        return {
            source: null,
            line: null,
            column: null,
            name: null
        };
    }
}
