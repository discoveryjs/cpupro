export const VM_STATE_JS = 0;
export const VM_STATE_GC = 1;
export const VM_STATE_PARSER = 2;
export const VM_STATE_COMPILER_BYTECODE = 3;
export const VM_STATE_COMPILER = 4;
export const VM_STATE_OTHER = 5;
export const VM_STATE_EXTERNAL = 6;
export const VM_STATE_IDLE = 7;
export const VM_STATE_ATOMICS_WAIT = 8;
export const VM_STATE_LOGGING = 9;

export const VM_STATES = [
    /* 0 */ 'js',
    /* 1 */ 'garbage collector',
    /* 2 */ 'parser',
    /* 3 */ 'bytecode compiler',
    /* 4 */ 'compiler',
    /* 5 */ 'other',
    /* 6 */ 'external',
    /* 7 */ 'idle',
    /* 8 */ 'atomics wait',
    /* 9 */ 'logging'
] as const;
