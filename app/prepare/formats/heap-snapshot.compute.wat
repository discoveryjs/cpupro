(import "imports" "memory" (memory 0))

;; Scans of a slice of a heap snapshot section (heap-snapshot.compute.ts). The state of a scan carries over slices
;; at state: the value being read (i64), whether it has a digit and whether it's negative (i32 each), then what
;; the scan of the slice found: the number of values, of exceptions and of strings, and whether it has values out
;; of u32 range (i32 each). The scans return the offset after the "]" closing the section, or -1 when the slice
;; doesn't close it

;; Numbers of a section of numbers, in their order, written at values as u32. PERF: The scan doesn't tell values
;; out of u32 range (negative, above 2^32 - 1) apart, which takes a branch per value and a third of the scan: it ORs
;; the values and flags the slice when the high bits of the OR are set or a "-" is met, and the slice is scanned again
;; by scanExceptions. A byte other than a digit or "-" ends a value
(func $scanNumbers (export "scanNumbers")
  (param $size i32)
  (param $bytes i32)
  (param $values i32)
  (param $state i32)
  (result i32)
  (local $offset i32)
  (local $byte i32)
  (local $digit i32)
  (local $value i64)
  (local $hasDigit i32)
  (local $bits i64)
  (local $count i32)
  (local $closed i32)

  (local.set $value (i64.load offset=0 (local.get $state)))
  (local.set $hasDigit (i32.load offset=8 (local.get $state)))
  ;; a negative value started in the previous slice flags this one as well
  (local.set $bits (i64.shl (i64.load32_u offset=12 (local.get $state)) (i64.const 32)))
  (local.set $closed (i32.const -1))

  ;; for (let offset = 0; offset < size;) {
  ;;   a digit adds to the value, "-" flags the slice
  ;;   another byte ends the value, it's written; "]" closes the section
  ;; }
  (block $done
    (loop $bytes
      (br_if $done (i32.ge_u (local.get $offset) (local.get $size)))

      (local.set $byte (i32.load8_u (i32.add (local.get $bytes) (local.get $offset))))
      (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
      (local.set $digit (i32.sub (local.get $byte) (i32.const 48)))

      (if (i32.lt_u (local.get $digit) (i32.const 10))
        (then
          (local.set $value
            (i64.add
              (i64.mul (local.get $value) (i64.const 10))
              (i64.extend_i32_u (local.get $digit))))
          (local.set $hasDigit (i32.const 1))
          (br $bytes)))

      (if (i32.eq (local.get $byte) (i32.const 45)) ;; -
        (then
          (local.set $bits (i64.const 0x100000000))
          (br $bytes)))

      (if (local.get $hasDigit)
        (then
          (i32.store
            (i32.add (local.get $values) (i32.shl (local.get $count) (i32.const 2)))
            (i32.wrap_i64 (local.get $value)))
          (local.set $bits (i64.or (local.get $bits) (local.get $value)))
          (local.set $count (i32.add (local.get $count) (i32.const 1)))))

      (local.set $value (i64.const 0))
      (local.set $hasDigit (i32.const 0))

      (br_if $bytes (i32.ne (local.get $byte) (i32.const 93))) ;; ]
      (local.set $closed (local.get $offset))))

  (i64.store offset=0 (local.get $state) (local.get $value))
  (i32.store offset=8 (local.get $state) (local.get $hasDigit))
  (i32.store offset=16 (local.get $state) (local.get $count))
  (i32.store offset=20 (local.get $state) (i32.const 0))
  (i32.store offset=28 (local.get $state) (i64.ne (i64.shr_u (local.get $bits) (i64.const 32)) (i64.const 0)))

  (local.get $closed)
)

;; Numbers of a slice as scanNumbers writes them, and values out of u32 range: the index of such a value among
;; the values of the slice is written at exceptionIndices and the value as f64 at exceptionValues
(func $scanExceptions (export "scanExceptions")
  (param $size i32)
  (param $bytes i32)
  (param $values i32)
  (param $exceptionIndices i32)
  (param $exceptionValues i32)
  (param $state i32)
  (result i32)
  (local $offset i32)
  (local $byte i32)
  (local $digit i32)
  (local $value i64)
  (local $hasDigit i32)
  (local $negative i32)
  (local $count i32)
  (local $exceptionCount i32)
  (local $closed i32)

  (local.set $value (i64.load offset=0 (local.get $state)))
  (local.set $hasDigit (i32.load offset=8 (local.get $state)))
  (local.set $negative (i32.load offset=12 (local.get $state)))
  (local.set $closed (i32.const -1))

  ;; for (let offset = 0; offset < size;) {
  ;;   a digit adds to the value, "-" makes it negative
  ;;   another byte ends the value: it's written, an exception also to exceptions; "]" closes the section
  ;; }
  (block $done
    (loop $bytes
      (br_if $done (i32.ge_u (local.get $offset) (local.get $size)))

      (local.set $byte (i32.load8_u (i32.add (local.get $bytes) (local.get $offset))))
      (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
      (local.set $digit (i32.sub (local.get $byte) (i32.const 48)))

      (if (i32.lt_u (local.get $digit) (i32.const 10))
        (then
          (local.set $value
            (i64.add
              (i64.mul (local.get $value) (i64.const 10))
              (i64.extend_i32_u (local.get $digit))))
          (local.set $hasDigit (i32.const 1))
          (br $bytes)))

      (if (i32.eq (local.get $byte) (i32.const 45)) ;; -
        (then
          (local.set $negative (i32.const 1))
          (br $bytes)))

      (if (local.get $hasDigit)
        (then
          (if (i32.or
                (local.get $negative)
                (i64.gt_u (local.get $value) (i64.const 0xFFFFFFFF)))
            (then
              (i32.store
                (i32.add (local.get $exceptionIndices) (i32.shl (local.get $exceptionCount) (i32.const 2)))
                (local.get $count))
              (f64.store
                (i32.add (local.get $exceptionValues) (i32.shl (local.get $exceptionCount) (i32.const 3)))
                (select
                  (f64.neg (f64.convert_i64_u (local.get $value)))
                  (f64.convert_i64_u (local.get $value))
                  (local.get $negative)))
              (local.set $exceptionCount (i32.add (local.get $exceptionCount) (i32.const 1)))))

          (i32.store
            (i32.add (local.get $values) (i32.shl (local.get $count) (i32.const 2)))
            (i32.wrap_i64 (local.get $value)))
          (local.set $count (i32.add (local.get $count) (i32.const 1)))))

      (local.set $value (i64.const 0))
      (local.set $hasDigit (i32.const 0))
      (local.set $negative (i32.const 0))

      (br_if $bytes (i32.ne (local.get $byte) (i32.const 93))) ;; ]
      (local.set $closed (local.get $offset))))

  (i64.store offset=0 (local.get $state) (local.get $value))
  (i32.store offset=8 (local.get $state) (local.get $hasDigit))
  (i32.store offset=12 (local.get $state) (local.get $negative))
  (i32.store offset=16 (local.get $state) (local.get $count))
  (i32.store offset=20 (local.get $state) (local.get $exceptionCount))

  (local.get $closed)
)

;; Values of a slice by field: the values of a field, every fieldCount-th from the first of the field (the values
;; start at firstField), go to fields one after another, the first field's first; a field's values are divided
;; by its divisor (u32 at divisors), a divisor of 1 takes a copy
(func $splitFields (export "splitFields")
  (param $count i32)
  (param $fieldCount i32)
  (param $firstField i32)
  (param $values i32)
  (param $fields i32)
  (param $divisors i32)
  (local $field i32)
  (local $value i32)
  (local $end i32)
  (local $step i32)
  (local $divisor i32)
  (local $out i32)

  (local.set $end (i32.add (local.get $values) (i32.shl (local.get $count) (i32.const 2))))
  (local.set $step (i32.shl (local.get $fieldCount) (i32.const 2)))
  (local.set $out (local.get $fields))

  ;; for (let field = 0; field < fieldCount; field++) {
  ;;   the field's values from its first one, divided when the divisor isn't 1
  ;; }
  (block $fieldsDone
    (loop $fieldsLoop
      (br_if $fieldsDone (i32.ge_u (local.get $field) (local.get $fieldCount)))

      (local.set $value
        (i32.add
          (local.get $values)
          (i32.shl
            (i32.rem_u
              (i32.sub (i32.add (local.get $field) (local.get $fieldCount)) (local.get $firstField))
              (local.get $fieldCount))
            (i32.const 2))))
      (local.set $divisor (i32.load (i32.add (local.get $divisors) (i32.shl (local.get $field) (i32.const 2)))))

      (if (i32.eq (local.get $divisor) (i32.const 1))
        (then
          (block $copyDone
            (loop $copy
              (br_if $copyDone (i32.ge_u (local.get $value) (local.get $end)))
              (i32.store (local.get $out) (i32.load (local.get $value)))
              (local.set $out (i32.add (local.get $out) (i32.const 4)))
              (local.set $value (i32.add (local.get $value) (local.get $step)))
              (br $copy))))
        (else
          (block $divideDone
            (loop $divide
              (br_if $divideDone (i32.ge_u (local.get $value) (local.get $end)))
              (i32.store (local.get $out) (i32.div_u (i32.load (local.get $value)) (local.get $divisor)))
              (local.set $out (i32.add (local.get $out) (i32.const 4)))
              (local.set $value (i32.add (local.get $value) (local.get $step)))
              (br $divide)))))

      (local.set $field (i32.add (local.get $field) (i32.const 1)))
      (br $fieldsLoop)))
)

;; Strings of the strings section: the offset of the first byte of every string after its opening quote is written
;; at starts, counted from the start of the section by sectionOffset of the slice. Inside a string "\" escapes
;; the next byte; the state's digit and negative slots hold whether the scan is inside a string and after "\"
(func $scanStrings (export "scanStrings")
  (param $size i32)
  (param $bytes i32)
  (param $starts i32)
  (param $sectionOffset i32)
  (param $state i32)
  (result i32)
  (local $offset i32)
  (local $byte i32)
  (local $inString i32)
  (local $escaped i32)
  (local $count i32)
  (local $closed i32)

  (local.set $inString (i32.load offset=8 (local.get $state)))
  (local.set $escaped (i32.load offset=12 (local.get $state)))
  (local.set $closed (i32.const -1))

  ;; for (let offset = 0; offset < size;) {
  ;;   inside a string: "\" escapes the next byte, an unescaped quote ends the string
  ;;   outside: a quote starts a string, "]" closes the section
  ;; }
  (block $done
    (loop $bytes
      (br_if $done (i32.ge_u (local.get $offset) (local.get $size)))

      (local.set $byte (i32.load8_u (i32.add (local.get $bytes) (local.get $offset))))
      (local.set $offset (i32.add (local.get $offset) (i32.const 1)))

      (if (local.get $inString)
        (then
          (if (local.get $escaped)
            (then
              (local.set $escaped (i32.const 0)))
            (else
              (if (i32.eq (local.get $byte) (i32.const 92)) ;; \
                (then
                  (local.set $escaped (i32.const 1)))
                (else
                  (local.set $inString (i32.ne (local.get $byte) (i32.const 34))))))) ;; "
          (br $bytes)))

      (if (i32.eq (local.get $byte) (i32.const 34)) ;; "
        (then
          (local.set $inString (i32.const 1))
          (i32.store
            (i32.add (local.get $starts) (i32.shl (local.get $count) (i32.const 2)))
            (i32.add (local.get $sectionOffset) (local.get $offset)))
          (local.set $count (i32.add (local.get $count) (i32.const 1)))
          (br $bytes)))

      (br_if $bytes (i32.ne (local.get $byte) (i32.const 93))) ;; ]
      (local.set $closed (local.get $offset))))

  (i32.store offset=8 (local.get $state) (local.get $inString))
  (i32.store offset=12 (local.get $state) (local.get $escaped))
  (i32.store offset=24 (local.get $state) (local.get $count))

  (local.get $closed)
)
