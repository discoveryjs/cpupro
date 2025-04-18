// temporary solution

export const ALLOCATION_SPACES = {
    0: 'read_only_space',
    1: 'new_space',
    2: 'old_space',
    3: 'code_space',
    4: 'shared_space',
    5: 'new_lo_space',   // lo = large object
    6: 'lo_space',       // lo = large object
    7: 'code_lo_space',  // lo = large object
    8: 'shared_lo_space' // lo = large object
};

export const ALLOCATION_TIMESPANS = {
    0: 'alive',
    1: 'short-lived',
    2: 'long-lived'
};

export const ALLOCATION_INSTANCE_TYPES = {
    0: 'INTERNALIZED_STRING',
    2: 'EXTERNAL_INTERNALIZED_STRING',
    8: 'ONE_BYTE_INTERNALIZED_STRING',
    10: 'EXTERNAL_ONE_BYTE_INTERNALIZED_STRING',
    18: 'UNCACHED_EXTERNAL_INTERNALIZED_STRING',
    26: 'UNCACHED_EXTERNAL_ONE_BYTE_INTERNALIZED_STRING',
    32: 'STRING',
    33: 'CONS_STRING',
    34: 'EXTERNAL_STRING',
    35: 'SLICED_STRING',
    37: 'THIN_STRING',
    40: 'ONE_BYTE_STRING',
    41: 'CONS_ONE_BYTE_STRING',
    42: 'EXTERNAL_ONE_BYTE_STRING',
    43: 'SLICED_ONE_BYTE_STRING',
    50: 'UNCACHED_EXTERNAL_STRING',
    58: 'UNCACHED_EXTERNAL_ONE_BYTE_STRING',
    96: 'SHARED_STRING',
    98: 'SHARED_EXTERNAL_STRING',
    104: 'SHARED_ONE_BYTE_STRING',
    106: 'SHARED_EXTERNAL_ONE_BYTE_STRING',
    114: 'SHARED_UNCACHED_EXTERNAL_STRING',
    122: 'SHARED_UNCACHED_EXTERNAL_ONE_BYTE_STRING',
    128: 'SYMBOL',
    129: 'BIG_INT_BASE',
    130: 'HEAP_NUMBER',
    131: 'ODDBALL',
    132: 'PROMISE_FULFILL_REACTION_JOB_TASK',
    133: 'PROMISE_REJECT_REACTION_JOB_TASK',
    134: 'CALLABLE_TASK',
    135: 'CALLBACK_TASK',
    136: 'PROMISE_RESOLVE_THENABLE_JOB_TASK',
    137: 'LOAD_HANDLER',
    138: 'STORE_HANDLER',
    139: 'FUNCTION_TEMPLATE_INFO',
    140: 'OBJECT_TEMPLATE_INFO',
    141: 'ACCESS_CHECK_INFO',
    142: 'ACCESSOR_PAIR',
    143: 'ALIASED_ARGUMENTS_ENTRY',
    144: 'ALLOCATION_MEMENTO',
    145: 'ALLOCATION_SITE',
    146: 'ARRAY_BOILERPLATE_DESCRIPTION',
    147: 'ASM_WASM_DATA',
    148: 'ASYNC_GENERATOR_REQUEST',
    149: 'BREAK_POINT',
    150: 'BREAK_POINT_INFO',
    151: 'CALL_SITE_INFO',
    152: 'CLASS_POSITIONS',
    153: 'DEBUG_INFO',
    154: 'ENUM_CACHE',
    155: 'ERROR_STACK_DATA',
    156: 'FEEDBACK_CELL',
    157: 'FUNCTION_TEMPLATE_RARE_DATA',
    158: 'INTERCEPTOR_INFO',
    159: 'INTERPRETER_DATA',
    160: 'MODULE_REQUEST',
    161: 'PROMISE_CAPABILITY',
    162: 'PROMISE_ON_STACK',
    163: 'PROMISE_REACTION',
    164: 'PROPERTY_DESCRIPTOR_OBJECT',
    165: 'PROTOTYPE_INFO',
    166: 'REG_EXP_BOILERPLATE_DESCRIPTION',
    167: 'SCRIPT',
    168: 'SCRIPT_OR_MODULE',
    169: 'SOURCE_TEXT_MODULE_INFO_ENTRY',
    170: 'STACK_FRAME_INFO',
    171: 'TEMPLATE_OBJECT_DESCRIPTION',
    172: 'TUPLE2',
    173: 'WASM_EXCEPTION_TAG',
    174: 'WASM_INDIRECT_FUNCTION_TABLE',
    175: 'FIXED_ARRAY',
    176: 'HASH_TABLE',
    177: 'EPHEMERON_HASH_TABLE',
    178: 'GLOBAL_DICTIONARY',
    179: 'NAME_DICTIONARY',
    180: 'NAME_TO_INDEX_HASH_TABLE',
    181: 'NUMBER_DICTIONARY',
    182: 'ORDERED_HASH_MAP',
    183: 'ORDERED_HASH_SET',
    184: 'ORDERED_NAME_DICTIONARY',
    185: 'REGISTERED_SYMBOL_TABLE',
    186: 'SIMPLE_NUMBER_DICTIONARY',
    187: 'CLOSURE_FEEDBACK_CELL_ARRAY',
    188: 'OBJECT_BOILERPLATE_DESCRIPTION',
    189: 'SCRIPT_CONTEXT_TABLE',
    190: 'BYTE_ARRAY',
    191: 'BYTECODE_ARRAY',
    192: 'FIXED_DOUBLE_ARRAY',
    193: 'INTERNAL_CLASS_WITH_SMI_ELEMENTS',
    194: 'SLOPPY_ARGUMENTS_ELEMENTS',
    195: 'TURBOSHAFT_FLOAT64_TYPE',
    196: 'TURBOSHAFT_FLOAT64_RANGE_TYPE',
    197: 'TURBOSHAFT_FLOAT64_SET_TYPE',
    198: 'TURBOSHAFT_WORD32_TYPE',
    199: 'TURBOSHAFT_WORD32_RANGE_TYPE',
    200: 'TURBOSHAFT_WORD32_SET_TYPE',
    201: 'TURBOSHAFT_WORD64_TYPE',
    202: 'TURBOSHAFT_WORD64_RANGE_TYPE',
    203: 'TURBOSHAFT_WORD64_SET_TYPE',
    204: 'FOREIGN',
    205: 'AWAIT_CONTEXT',
    206: 'BLOCK_CONTEXT',
    207: 'CATCH_CONTEXT',
    208: 'DEBUG_EVALUATE_CONTEXT',
    209: 'EVAL_CONTEXT',
    210: 'FUNCTION_CONTEXT',
    211: 'MODULE_CONTEXT',
    212: 'NATIVE_CONTEXT',
    213: 'SCRIPT_CONTEXT',
    214: 'WITH_CONTEXT',
    215: 'TURBOFAN_BITSET_TYPE',
    216: 'TURBOFAN_HEAP_CONSTANT_TYPE',
    217: 'TURBOFAN_OTHER_NUMBER_CONSTANT_TYPE',
    218: 'TURBOFAN_RANGE_TYPE',
    219: 'TURBOFAN_UNION_TYPE',
    220: 'UNCOMPILED_DATA_WITH_PREPARSE_DATA',
    221: 'UNCOMPILED_DATA_WITH_PREPARSE_DATA_AND_JOB',
    222: 'UNCOMPILED_DATA_WITHOUT_PREPARSE_DATA',
    223: 'UNCOMPILED_DATA_WITHOUT_PREPARSE_DATA_WITH_JOB',
    224: 'WASM_FUNCTION_DATA',
    225: 'WASM_CAPI_FUNCTION_DATA',
    226: 'WASM_EXPORTED_FUNCTION_DATA',
    227: 'WASM_JS_FUNCTION_DATA',
    228: 'EXPORTED_SUB_CLASS_BASE',
    229: 'EXPORTED_SUB_CLASS',
    230: 'EXPORTED_SUB_CLASS2',
    231: 'SMALL_ORDERED_HASH_MAP',
    232: 'SMALL_ORDERED_HASH_SET',
    233: 'SMALL_ORDERED_NAME_DICTIONARY',
    234: 'ABSTRACT_INTERNAL_CLASS_SUBCLASS1',
    235: 'ABSTRACT_INTERNAL_CLASS_SUBCLASS2',
    236: 'DESCRIPTOR_ARRAY',
    237: 'STRONG_DESCRIPTOR_ARRAY',
    238: 'SOURCE_TEXT_MODULE',
    239: 'SYNTHETIC_MODULE',
    240: 'WEAK_FIXED_ARRAY',
    241: 'TRANSITION_ARRAY',
    242: 'ACCESSOR_INFO',
    243: 'CALL_HANDLER_INFO',
    244: 'CELL',
    245: 'CODE',
    246: 'COVERAGE_INFO',
    247: 'EMBEDDER_DATA_ARRAY',
    248: 'FEEDBACK_METADATA',
    249: 'FEEDBACK_VECTOR',
    250: 'FILLER',
    251: 'FREE_SPACE',
    252: 'INSTRUCTION_STREAM',
    253: 'INTERNAL_CLASS',
    254: 'INTERNAL_CLASS_WITH_STRUCT_ELEMENTS',
    255: 'MAP',
    256: 'MEGA_DOM_HANDLER',
    257: 'ON_HEAP_BASIC_BLOCK_PROFILER_DATA',
    258: 'PREPARSE_DATA',
    259: 'PROPERTY_ARRAY',
    260: 'PROPERTY_CELL',
    261: 'SCOPE_INFO',
    262: 'SHARED_FUNCTION_INFO',
    263: 'SMI_BOX',
    264: 'SMI_PAIR',
    265: 'SORT_STATE',
    266: 'SWISS_NAME_DICTIONARY',
    267: 'WASM_API_FUNCTION_REF',
    268: 'WASM_CONTINUATION_OBJECT',
    269: 'WASM_INTERNAL_FUNCTION',
    270: 'WASM_NULL',
    271: 'WASM_RESUME_DATA',
    272: 'WASM_STRING_VIEW_ITER',
    273: 'WASM_TYPE_INFO',
    274: 'WEAK_ARRAY_LIST',
    275: 'WEAK_CELL',
    276: 'WASM_ARRAY',
    277: 'WASM_STRUCT',
    278: 'JS_PROXY',
    1057: 'JS_OBJECT',
    279: 'JS_GLOBAL_OBJECT',
    280: 'JS_GLOBAL_PROXY',
    281: 'JS_MODULE_NAMESPACE',
    1040: 'JS_SPECIAL_API_OBJECT',
    1041: 'JS_PRIMITIVE_WRAPPER',
    1058: 'JS_API_OBJECT',
    2058: 'JS_LAST_DUMMY_API_OBJECT',
    2059: 'JS_DATA_VIEW',
    2060: 'JS_RAB_GSAB_DATA_VIEW',
    2061: 'JS_TYPED_ARRAY',
    2062: 'JS_ARRAY_BUFFER',
    2063: 'JS_PROMISE',
    2064: 'JS_BOUND_FUNCTION',
    2065: 'JS_WRAPPED_FUNCTION',
    2066: 'JS_FUNCTION',
    2067: 'BIGINT64_TYPED_ARRAY_CONSTRUCTOR',
    2068: 'BIGUINT64_TYPED_ARRAY_CONSTRUCTOR',
    2069: 'FLOAT32_TYPED_ARRAY_CONSTRUCTOR',
    2070: 'FLOAT64_TYPED_ARRAY_CONSTRUCTOR',
    2071: 'INT16_TYPED_ARRAY_CONSTRUCTOR',
    2072: 'INT32_TYPED_ARRAY_CONSTRUCTOR',
    2073: 'INT8_TYPED_ARRAY_CONSTRUCTOR',
    2074: 'UINT16_TYPED_ARRAY_CONSTRUCTOR',
    2075: 'UINT32_TYPED_ARRAY_CONSTRUCTOR',
    2076: 'UINT8_CLAMPED_TYPED_ARRAY_CONSTRUCTOR',
    2077: 'UINT8_TYPED_ARRAY_CONSTRUCTOR',
    2078: 'JS_ARRAY_CONSTRUCTOR',
    2079: 'JS_PROMISE_CONSTRUCTOR',
    2080: 'JS_REG_EXP_CONSTRUCTOR',
    2081: 'JS_CLASS_CONSTRUCTOR',
    2082: 'JS_ARRAY_ITERATOR_PROTOTYPE',
    2083: 'JS_ITERATOR_PROTOTYPE',
    2084: 'JS_MAP_ITERATOR_PROTOTYPE',
    2085: 'JS_OBJECT_PROTOTYPE',
    2086: 'JS_PROMISE_PROTOTYPE',
    2087: 'JS_REG_EXP_PROTOTYPE',
    2088: 'JS_SET_ITERATOR_PROTOTYPE',
    2089: 'JS_SET_PROTOTYPE',
    2090: 'JS_STRING_ITERATOR_PROTOTYPE',
    2091: 'JS_TYPED_ARRAY_PROTOTYPE',
    2092: 'JS_MAP_KEY_ITERATOR',
    2093: 'JS_MAP_KEY_VALUE_ITERATOR',
    2094: 'JS_MAP_VALUE_ITERATOR',
    2095: 'JS_SET_KEY_VALUE_ITERATOR',
    2096: 'JS_SET_VALUE_ITERATOR',
    2097: 'JS_ATOMICS_CONDITION',
    2098: 'JS_ATOMICS_MUTEX',
    2099: 'JS_SHARED_ARRAY',
    2100: 'JS_SHARED_STRUCT',
    2101: 'JS_ITERATOR_DROP_HELPER',
    2102: 'JS_ITERATOR_FILTER_HELPER',
    2103: 'JS_ITERATOR_MAP_HELPER',
    2104: 'JS_ITERATOR_TAKE_HELPER',
    2105: 'JS_GENERATOR_OBJECT',
    2106: 'JS_ASYNC_FUNCTION_OBJECT',
    2107: 'JS_ASYNC_GENERATOR_OBJECT',
    2108: 'JS_MAP',
    2109: 'JS_SET',
    2110: 'JS_WEAK_MAP',
    2111: 'JS_WEAK_SET',
    2112: 'JS_ARGUMENTS_OBJECT',
    2113: 'JS_ARRAY',
    2114: 'JS_ARRAY_ITERATOR',
    2115: 'JS_ASYNC_FROM_SYNC_ITERATOR',
    2116: 'JS_COLLATOR',
    2117: 'JS_CONTEXT_EXTENSION_OBJECT',
    2118: 'JS_DATE',
    2119: 'JS_DATE_TIME_FORMAT',
    2120: 'JS_DISPLAY_NAMES',
    2121: 'JS_DURATION_FORMAT',
    2122: 'JS_ERROR',
    2123: 'JS_EXTERNAL_OBJECT',
    2124: 'JS_FINALIZATION_REGISTRY',
    2125: 'JS_LIST_FORMAT',
    2126: 'JS_LOCALE',
    2127: 'JS_MESSAGE_OBJECT',
    2128: 'JS_NUMBER_FORMAT',
    2129: 'JS_PLURAL_RULES',
    2130: 'JS_RAW_JSON',
    2131: 'JS_REG_EXP',
    2132: 'JS_REG_EXP_STRING_ITERATOR',
    2133: 'JS_RELATIVE_TIME_FORMAT',
    2134: 'JS_SEGMENT_ITERATOR',
    2135: 'JS_SEGMENTER',
    2136: 'JS_SEGMENTS',
    2137: 'JS_SHADOW_REALM',
    2138: 'JS_STRING_ITERATOR',
    2139: 'JS_TEMPORAL_CALENDAR',
    2140: 'JS_TEMPORAL_DURATION',
    2141: 'JS_TEMPORAL_INSTANT',
    2142: 'JS_TEMPORAL_PLAIN_DATE',
    2143: 'JS_TEMPORAL_PLAIN_DATE_TIME',
    2144: 'JS_TEMPORAL_PLAIN_MONTH_DAY',
    2145: 'JS_TEMPORAL_PLAIN_TIME',
    2146: 'JS_TEMPORAL_PLAIN_YEAR_MONTH',
    2147: 'JS_TEMPORAL_TIME_ZONE',
    2148: 'JS_TEMPORAL_ZONED_DATE_TIME',
    2149: 'JS_V8_BREAK_ITERATOR',
    2150: 'JS_VALID_ITERATOR_WRAPPER',
    2151: 'JS_WEAK_REF',
    2152: 'WASM_EXCEPTION_PACKAGE',
    2153: 'WASM_GLOBAL_OBJECT',
    2154: 'WASM_INSTANCE_OBJECT',
    2155: 'WASM_MEMORY_OBJECT',
    2156: 'WASM_MODULE_OBJECT',
    2157: 'WASM_SUSPENDER_OBJECT',
    2158: 'WASM_TABLE_OBJECT',
    2159: 'WASM_TAG_OBJECT',
    2160: 'WASM_VALUE_OBJECT'
};
