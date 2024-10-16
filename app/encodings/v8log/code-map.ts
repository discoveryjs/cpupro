import { CodeState } from './types.js';

const pageAlignment = 12;
const pageSize = 1 << pageAlignment;

class CodeEntry {
    size: number;
    name: string;
    type: string;
    nameUpdated_: boolean; // ???
    source: string | undefined;

    constructor(size: number, name = '', type = '') {
        this.size = size;
        this.name = name || '';
        this.type = type || '';
        this.nameUpdated_ = false;
        this.source = undefined;
    }
}

class SharedFunctionInfoEntry extends CodeEntry {
    constructor(name: string) {
        super(0, name);
        // const index = name.lastIndexOf(' ');
        // this.functionName = 1 <= index ? name.substring(0, index) : '<anonymous>';
    }
}

class DynamicFuncCodeEntry extends CodeEntry {
    sfi: SharedFunctionInfoEntry;
    state: CodeState;

    constructor(size: number, type: string, sfi: SharedFunctionInfoEntry, state: CodeState) {
        super(size, '', type);
        this.sfi = sfi;
        this.state = state;
        // sfi.addDynamicCode(this);
    }
}

class NameGenerator {}
export class CodeMap {
    /**
     * Dynamic code entries. Used for JIT compiled code.
     */
    dynamics_ = new Map<number, DynamicFuncCodeEntry | SharedFunctionInfoEntry>();

    /**
     * Name generator for entries having duplicate names.
     */
    dynamicsNameGen_ = new NameGenerator();

    /**
     * Static code entries. Used for statically compiled code.
     */
    statics_ = new Map<number, CodeEntry>();

    /**
     * Libraries entries. Used for the whole static code libraries.
     */
    libraries_ = new Map<number, CodeEntry>();

    /**
     * Map of memory pages occupied with static code.
     */
    pages_ = new Set();

    findDynamicEntryByStartAddress(addr: number) {
        return this.dynamics_.get(addr) || null;
    }
    addCode(start: number, codeEntry) {
        // this.deleteAllCoveredNodes_(this.dynamics_, start, start + codeEntry.size);
        this.dynamics_.set(start, codeEntry);
    }
    moveCode(from: number, to: number) {
        const removedCode = this.dynamics_.get(from);
        this.dynamics_.delete(from);
        // this.deleteAllCoveredNodes_(this.dynamics_, to, to + removedCode.value.size);
        if (removedCode !== undefined) {
            this.dynamics_.set(to, removedCode);
        } else {
            console.warn('CodeMap#moveCode() from code doesn\'t found');
        }
    }
    deleteCode(start: number) {
        this.dynamics_.delete(start);
    }

    addStaticCode(start: number, codeEntry: CodeEntry) {
        this.statics_.set(start, codeEntry);
    }

    addLibrary(start: number, codeEntry: CodeEntry) {
        this.markPages_(start, start + codeEntry.size);
        this.libraries_.set(start, codeEntry);
    }

    markPages_(start: number, end: number) {
        for (let addr = start; addr <= end; addr += pageSize) {
            this.pages_.add((addr / pageSize) | 0);
        }
    }
}
