import { parsePositions } from '../prepare/formats/v8-log-processed/positions.js';

export const methods = {
    parsePositions(value, size = 0) {
        if (typeof value !== 'string' || value === '') {
            return [];
        }

        const parsed = parsePositions(String(value));
        const result = [];
        let last = null;

        for (let i = 0; i < parsed.length; i += 3) {
            const code = parsed[i];
            const offset = parsed[i + 1];
            const inline = parsed[i + 2];

            if (last !== null) {
                last.size = code - last.code;
            }

            result.push(last = {
                index: result.length,
                code,
                offset,
                inline: inline !== -1 ? inline : undefined,
                size: -1
            });
        }

        if (size > 0 && last !== null) {
            last.size = Math.max(size - last.code, -1);
        }

        return result;
    },

    parseInlined(value, fns) {
        if (typeof value !== 'string' || value === '') {
            return [];
        }

        const parsed = parsePositions(String(value));
        const result = [];

        for (let i = 0; i < parsed.length; i += 3) {
            const fn = parsed[i];
            const offset = parsed[i + 1];
            const parent = parsed[i + 2];
            const entry = {
                index: result.length,
                fn,
                offset,
                parent: parent !== -1 ? parent : undefined
            };

            result.push(entry);

            if (Array.isArray(fns)) {
                entry.callFrame = fns[fn] || null;
            }
        }

        return result;
    },

    inlinedPath(path, callFrame, offset) {
        let cursor = { callFrame, offset: -1, parent: null };
        const result = [cursor];

        for (const { callFrame, offset } of path) {
            cursor.offset = offset;
            cursor = { callFrame, offset: -1, parent: cursor };
            result.push(cursor);
        }

        cursor.offset = offset;

        return result;
    },

    inlinedMatrix(codes = []) {
        const recordByRef = new Map();
        const roots = [];
        const result = [];

        for (let i = 0; i < codes.length; i++) {
            const code = codes[i];
            const parsed = this.method('parseInlined', code.inlined);
            const records = [];

            for (const entry of parsed) {
                const callFrame = code.fns[entry.fn];
                const parentRecord = entry.parent === undefined ? null : records[entry.parent];
                const ref = parentRecord !== null
                    ? `${entry.offset}-${callFrame.id}-${parentRecord.id}`
                    : `${entry.offset}-${callFrame.id}`;
                let record = recordByRef.get(ref);

                if (record === undefined) {
                    recordByRef.set(ref, record = {
                        id: recordByRef.size,
                        value: { offset: entry.offset, callFrame, code },
                        parent: parentRecord,
                        children: [],
                        codePresence: Array.from(codes, () => 0)
                    });

                    if (parentRecord !== null) {
                        parentRecord.children.push(record);
                    } else {
                        roots.push(record);
                    }
                }

                record.codePresence[i] = 1;
                records.push(record);
            }
        }

        for (const root of sortByOffset(roots)) {
            const linear = [];

            walkTree(root, node => {
                linear.push(node);
                sortByOffset(node.children);
            });

            const snapshots = [];
            let min = linear.length;
            let max = 0;

            for (let i = 0; i < codes.length; i++) {
                const presence = Array.from(linear, record => record.codePresence[i]);
                const hash = presence.join('');
                const count = this.method('sum', presence);

                if (count !== 0 && count < min) {
                    min = count;
                }

                if (count > max) {
                    max = count;
                }

                snapshots.push({
                    hash,
                    presence,
                    code: codes[i]
                });
            }

            result.push({
                offset: root.value.offset,
                tree: root,
                linear: linear.map(x => x.value),
                min,
                max,
                snapshots
            });
        }

        return result;

        function sortByOffset(array) {
            if (array.length > 1) {
                array.sort((a, b) => a.value.offset - b.value.offset);
            }

            return array;
        }

        function walkTree(node, fn) {
            fn(node);
            for (const child of node.children) {
                walkTree(child, fn);
            }
        }
    }
};
