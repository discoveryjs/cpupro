(import "imports" "memory" (memory 0))

;; Values of memline attributes for a chunk of allocations staged into the buffer: codes and context info are u32
;; (4 bytes), as are the elements of a table of codes; kinds of context info and code types are bytes

;; Dictionary indices of codes through a table indexed by the codes, 0 for a code beyond the table. Indices are
;; elements of 1 or 4 bytes (a step), written as 4 bytes at their address: the bytes past a 1-byte index go
;; to the next one, which is written after it, and the buffer has room after the last one
(func $dictIndices (export "dictIndices")
  (param $size i32)
  (param $codes i32)
  (param $table i32)
  (param $tableLength i32)
  (param $values i32)
  (param $valuesStep i32)
  (local $codesEnd i32)
  (local $code i32)

  ;; for (let i = 0; i < size; i++) {
  ;;   values[i] = codes[i] < tableLength ? table[codes[i]] : 0
  ;; }
  ;; The table has an entry of 0 after its last one, which codes beyond it read

  (local.set $codesEnd (i32.add (local.get $codes) (i32.shl (local.get $size) (i32.const 2))))

  (block $exit
    (loop $next
      (br_if $exit (i32.eq (local.get $codes) (local.get $codesEnd)))

      (local.set $code (i32.load (local.get $codes)))
      (i32.store
        (local.get $values)
        (i32.load
          (i32.add
            (local.get $table)
            (i32.shl
              (select
                (local.get $code)
                (local.get $tableLength)
                (i32.lt_u (local.get $code) (local.get $tableLength)))
              (i32.const 2)))))

      (local.set $codes (i32.add (local.get $codes) (i32.const 4)))
      (local.set $values (i32.add (local.get $values) (local.get $valuesStep)))
      (br $next)
    )
  )
)

;; Code types of allocations: an allocation in a context of the builtin kind takes the builtin type, of the VM state
;; kind the other type, and its own code type otherwise. Kinds of context info are a u8 table indexed by context info
;; (contextInfoKind: 0 JS, 1 VM state, 2 builtin). A pass stops at the first context info beyond the table and returns
;; the number of allocations it gave values, size when none is beyond
(func $contextCodeTypes (export "contextCodeTypes")
  (param $size i32)
  (param $codeTypes i32)
  (param $contextInfo i32)
  (param $kinds i32)
  (param $kindsLength i32)
  (param $builtinType i32)
  (param $otherType i32)
  (param $values i32)
  (result i32)
  (local $valuesStart i32)
  (local $valuesEnd i32)
  (local $info i32)
  (local $kind i32)

  ;; for (let i = 0; i < size && contextInfo[i] < kindsLength; i++) {
  ;;   kind = kinds[contextInfo[i]]
  ;;   values[i] = kind === 1 ? otherType : kind === 2 ? builtinType : codeTypes[i]
  ;; }
  ;; Values are bytes, the index of an allocation is values - valuesStart

  ;; PERF: Kinds of context info change unpredictably between allocations, so values are selected without branches:
  ;; branches per allocation cost about 2.5 times as much in Chrome
  (local.set $valuesStart (local.get $values))
  (local.set $valuesEnd (i32.add (local.get $values) (local.get $size)))

  (block $exit
    (loop $next
      (br_if $exit (i32.eq (local.get $values) (local.get $valuesEnd)))

      (local.set $info (i32.load (local.get $contextInfo)))
      (br_if $exit (i32.ge_u (local.get $info) (local.get $kindsLength)))

      (local.set $kind (i32.load8_u (i32.add (local.get $kinds) (local.get $info))))
      (i32.store8
        (local.get $values)
        (select
          (local.get $otherType)
          (select
            (local.get $builtinType)
            (i32.load (local.get $codeTypes))
            (i32.eq (local.get $kind) (i32.const 2)))
          (i32.eq (local.get $kind) (i32.const 1))))

      (local.set $codeTypes (i32.add (local.get $codeTypes) (i32.const 4)))
      (local.set $contextInfo (i32.add (local.get $contextInfo) (i32.const 4)))
      (local.set $values (i32.add (local.get $values) (i32.const 1)))
      (br $next)
    )
  )

  (i32.sub (local.get $values) (local.get $valuesStart))
)
