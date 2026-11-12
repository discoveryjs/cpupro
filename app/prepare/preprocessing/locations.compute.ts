import { createUint32Progression, powerOfTwoCapacity } from '../misc/utils.js';
import { createComputeBuffer, wasmBacked, type WasmExports } from '../computations/compute-wasm.js';
import locationsWasm from './locations.compute.wasm';

// Sites of locations: script offsets of owners (call frames, call tree nodes or script ids) with context info,
// numbered in the order they are found. The table of sites is a compute buffer: elements find their sites
// in chunks staged into the buffer, by WASM or JavaScript, and the table grows between chunks.
// The table grows since the number of sites is known only once they are found, and the bound from the input,
// the number of elements, is about a hundred times the sites of an allocation trace; a temporary Array doesn't
// fit, since WASM finds sites in the table itself.
export class LocationSites {
    count = 0;
    #buffer: SitesBuffer;
    #api: SitesApi;

    constructor(size: number) {
        this.#buffer = createSitesBuffer(powerOfTwoCapacity(size));
        this.#api = sitesApiOf(this.#buffer);
    }

    get owners() {
        return this.#buffer.siteOwners;
    }

    get offsets() {
        return this.#buffer.siteOffsets;
    }

    get contexts() {
        return this.#buffer.siteContexts;
    }

    // Sites of the elements of owners, offsets and contexts (zero when absent); sites may be owners,
    // since a chunk of elements is staged before its sites are written
    sitesOf(
        owners: Uint32Array,
        offsets: Int32Array,
        contexts: Uint32Array | null,
        sites: Uint32Array
    ) {
        let start = 0;

        while (start < offsets.length) {
            const end = Math.min(offsets.length, start + this.#buffer.sites.length);
            const size = end - start;

            // The table grows to room for the chunk's sites, the chunk of a grown table is no smaller
            if (this.count + size > this.owners.length) {
                this.#grow(powerOfTwoCapacity(this.count + size));
            }

            const buffer = this.#buffer;

            buffer.owners.set(owners.subarray(start, end));
            buffer.offsets.set(offsets.subarray(start, end));

            if (contexts !== null) {
                buffer.contexts.set(contexts.subarray(start, end));
            } else {
                buffer.contexts.fill(0);
            }

            this.count = this.#api.findSites(buffer, size, this.count);
            sites.set(buffer.sites.subarray(0, size), start);
            start = end;
        }
    }

    // Sites in ascending offsets of each owner, the owners in the order of their first sites: a radix sort
    // of offsets by 16-bit digits followed by a stable sort by owner
    ownerOffsetOrder() {
        const keys = new Uint32Array(this.count);
        const ownerKeys = new Map<number, number>();

        for (let i = 0; i < this.count; i++) {
            keys[i] = this.offsets[i] & 0xffff;
        }

        const lowDigitOrder = countingSort(createUint32Progression(this.count), keys, 0x10000);

        // The sign bit of the high digit is flipped, so negative offsets come first
        for (let i = 0; i < this.count; i++) {
            keys[i] = (this.offsets[i] >>> 16) ^ 0x8000;
        }

        const offsetOrder = countingSort(lowDigitOrder, keys, 0x10000);

        for (let i = 0; i < this.count; i++) {
            let ownerKey = ownerKeys.get(this.owners[i]);

            if (ownerKey === undefined) {
                ownerKey = ownerKeys.size;
                ownerKeys.set(this.owners[i], ownerKey);
            }

            keys[i] = ownerKey;
        }

        return countingSort(offsetOrder, keys, ownerKeys.size);
    }

    #grow(size: number) {
        const buffer = createSitesBuffer(size);
        const slots = buffer.slots;
        const slotMask = slots.length - 1;

        buffer.siteOwners.set(this.owners.subarray(0, this.count));
        buffer.siteOffsets.set(this.offsets.subarray(0, this.count));
        buffer.siteContexts.set(this.contexts.subarray(0, this.count));

        for (let i = 0; i < this.count; i++) {
            let slot = hashSite(this.owners[i], this.offsets[i], this.contexts[i]) & slotMask;

            while (slots[slot] !== -1) {
                slot = (slot + 1) & slotMask;
            }

            slots[slot] = i;
        }

        this.#buffer = buffer;
        this.#api = sitesApiOf(buffer);
    }
}

// PERF: WASM reads its own memory only, so chunks of elements are staged into the buffer: the buffer stays small
// for any number of elements, and V8 replaces the baseline code of a WASM function by optimized code between calls
// rather than during one, so chunks after the first run optimized code
const sitesChunkSize = 1 << 16;

// A buffer of a table for a capacity of sites, its slots stay at most half occupied. Elements of owners, offsets
// and contexts get their sites; the table holds the site of each key at slots and the keys of sites at siteOwners,
// siteOffsets and siteContexts
function createSitesBuffer(siteCapacity: number) {
    const chunkSize = Math.min(siteCapacity, sitesChunkSize);
    const buffer = createComputeBuffer({
        owners: [Uint32Array, chunkSize],
        offsets: [Int32Array, chunkSize],
        contexts: [Uint32Array, chunkSize],
        sites: [Uint32Array, chunkSize],
        slots: [Int32Array, 2 * siteCapacity],
        siteOwners: [Uint32Array, siteCapacity],
        siteOffsets: [Int32Array, siteCapacity],
        siteContexts: [Uint32Array, siteCapacity]
    });

    buffer.slots.fill(-1);

    return buffer;
}

type SitesBuffer = ReturnType<typeof createSitesBuffer>;
type SitesApi = typeof sitesJavaScriptApi;

// findSites of locations.compute.wat: sites of the first size elements, the table has room for size more sites;
// returns the site count
const sitesJavaScriptApi = {
    findSites(buffer: SitesBuffer, size: number, count: number) {
        const {
            owners,
            offsets,
            contexts,
            sites,
            slots,
            siteOwners,
            siteOffsets,
            siteContexts
        } = buffer;
        const slotMask = slots.length - 1;
        let owner = 0;
        let offset = 0;
        let context = 0;
        let site = 0;

        for (let i = 0; i < size; i++) {
            // An element of the previous key takes its site without a lookup
            if (i === 0 ||
                offsets[i] !== offset ||
                contexts[i] !== context ||
                owners[i] !== owner) {
                owner = owners[i];
                offset = offsets[i];
                context = contexts[i];

                const homeSlot = hashSite(owner, offset, context) & slotMask;
                let slot = homeSlot;

                site = slots[slot];

                while (site !== -1) {
                    if (siteOffsets[site] === offset &&
                        siteContexts[site] === context &&
                        siteOwners[site] === owner) {
                        break;
                    }

                    slot = (slot + 1) & slotMask;
                    site = slots[slot];
                }

                if (site === -1) {
                    site = count++;
                    siteOwners[site] = owner;
                    siteOffsets[site] = offset;
                    siteContexts[site] = context;
                    slots[slot] = site;
                } else if (slot !== homeSlot) {
                    // PERF: A found site takes its home slot, so sites met again are found at the first probe.
                    // The site displaced from the home slot takes the found one's slot, which follows the home slot
                    // in the same run of occupied slots, so a probe from its own home slot still reaches it
                    slots[slot] = slots[homeSlot];
                    slots[homeSlot] = site;
                }
            }

            sites[i] = site;
        }

        return count;
    }
};
const sitesApiOf = wasmBacked(locationsWasm, sitesJavaScriptApi, bindSitesWasm);

function bindSitesWasm(wasm: WasmExports<'findSites'>): SitesApi {
    return {
        findSites(buffer, size, count) {
            return wasm.findSites(
                size,
                buffer.owners.byteOffset,
                buffer.offsets.byteOffset,
                buffer.contexts.byteOffset,
                buffer.sites.byteOffset,
                buffer.slots.byteOffset,
                buffer.slots.length - 1,
                buffer.siteOwners.byteOffset,
                buffer.siteOffsets.byteOffset,
                buffer.siteContexts.byteOffset,
                count
            );
        }
    };
}

// The hash of findSites in locations.wat, a grown table places its sites by it
function hashSite(owner: number, offset: number, context: number) {
    const key = owner ^ Math.imul(offset, 0x85ebca6b) ^ Math.imul(context, 0xc2b2ae35);
    const hash = Math.imul(key, 0x9e3779b1);

    return (hash ^ (hash >>> 16)) >>> 0;
}

// Indices in a stable order of their keys, the keys are below the key count
function countingSort(indices: Uint32Array, keys: Uint32Array, keyCount: number) {
    const keyStarts = new Uint32Array(keyCount + 1);
    const sorted = new Uint32Array(indices.length);

    for (let i = 0; i < indices.length; i++) {
        keyStarts[keys[indices[i]] + 1]++;
    }

    for (let i = 0; i < keyCount; i++) {
        keyStarts[i + 1] += keyStarts[i];
    }

    for (let i = 0; i < indices.length; i++) {
        const index = indices[i];

        sorted[keyStarts[keys[index]]++] = index;
    }

    return sorted;
}
