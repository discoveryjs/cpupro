(import "imports" "memory" (memory 0))

;; The index pass of a source map over a chunk of its mappings (source-map.compute.ts): segments are decoded,
;; a checkpoint (6 x i32: column, previous column, offset, source, original line, original column) is written
;; at the start of a line and before a segment after several segments, the first checkpoint of each line the chunk
;; starts at lineCheckpoints, a line with a segment before the previous one's column at unsortedLines. The chunk
;; ends after a separator or with the mappings, and the byte after it is a separator, so a segment ends without
;; a bounds check; the state of decoding carries over chunks at state (7 x i32: line, segments of the line, segments
;; after the last checkpoint, generated column, source, original line, original column), followed by the checkpoint
;; count of the mappings and the unsorted line count of the chunk. A byte of the mappings has its value
;; at charValues: a base64 digit, 254 for a separator, 255 for an invalid byte. Returns -1, or the offset
;; of an invalid byte in the chunk
;;
;; PERF: The fields of a segment are decoded one by one, each by its own copy of the decoding of a value: V8 doesn't
;; inline a function decoding a value, and over the source maps of a large trace (70 MB of mappings) the pass took
;; 169 ms with such a function, 131 ms with a loop over the kinds of fields and 112 ms with the copies
(func $indexMappings (export "indexMappings")
  (param $size i32)
  (param $start i32)
  (param $mappings i32)
  (param $charValues i32)
  (param $state i32)
  (param $checkpoints i32)
  (param $lineCheckpoints i32)
  (param $unsortedLines i32)
  (param $checkpointSegments i32)
  (result i32)
  (local $offset i32)
  (local $segmentOffset i32)
  (local $digit i32)
  (local $value i32)
  (local $shift i32)
  (local $line i32)
  (local $lineSegments i32)
  (local $segmentsAfterCheckpoint i32)
  (local $generatedColumn i32)
  (local $source i32)
  (local $originalLine i32)
  (local $originalColumn i32)
  (local $checkpointCount i32)
  (local $checkpointAddr i32)
  (local $lineCount i32)
  (local $unsortedLineCount i32)

  (local.set $line (i32.load offset=0 (local.get $state)))
  (local.set $lineSegments (i32.load offset=4 (local.get $state)))
  (local.set $segmentsAfterCheckpoint (i32.load offset=8 (local.get $state)))
  (local.set $generatedColumn (i32.load offset=12 (local.get $state)))
  (local.set $source (i32.load offset=16 (local.get $state)))
  (local.set $originalLine (i32.load offset=20 (local.get $state)))
  (local.set $originalColumn (i32.load offset=24 (local.get $state)))
  (local.set $checkpointCount (i32.load offset=28 (local.get $state)))
  (local.set $checkpointAddr (local.get $checkpoints))

  ;; for (let offset = 0; offset < size;) {
  ;;   ";" starts a line, "," is skipped
  ;;   the generated column of a segment is decoded, the line is unsorted when the column goes back,
  ;;   a checkpoint is written at the start of a line and after several segments at a greater column
  ;;   the source, original line and column are decoded, the rest (a name) is skipped
  ;; }

  (block $exit
    (loop $loop
      (br_if $exit (i32.ge_u (local.get $offset) (local.get $size)))

      (local.set $digit (i32.load8_u (i32.add (local.get $mappings) (local.get $offset))))

      ;; ";"
      (if (i32.eq (local.get $digit) (i32.const 59))
        (then
          (i32.store
            (i32.add (local.get $lineCheckpoints) (i32.shl (local.get $lineCount) (i32.const 2)))
            (local.get $checkpointCount)
          )
          (local.set $lineCount (i32.add (local.get $lineCount) (i32.const 1)))
          (local.set $line (i32.add (local.get $line) (i32.const 1)))
          (local.set $lineSegments (i32.const 0))
          (local.set $generatedColumn (i32.const 0))
          (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
          (br $loop)
        )
      )

      ;; ","
      (if (i32.eq (local.get $digit) (i32.const 44))
        (then
          (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
          (br $loop)
        )
      )

      (local.set $segmentOffset (local.get $offset))
      (local.set $digit (i32.load8_u (i32.add (local.get $charValues) (local.get $digit))))

      (if (i32.eq (local.get $digit) (i32.const 255))
        (then
          (return (local.get $offset))
        )
      )

      ;; the generated column
      ;; value of the digit at offset, the offset moves after the value's last digit
      (local.set $value (i32.and (local.get $digit) (i32.const 31)))

      (if (i32.and (local.get $digit) (i32.const 32))
        (then
          (local.set $shift (i32.const 5))

          (loop $continuation
            (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
            (local.set $digit
              (i32.load8_u
                (i32.add
                  (local.get $charValues)
                  (i32.load8_u (i32.add (local.get $mappings) (local.get $offset)))
                )
              )
            )

            ;; a value can't end with a separator, the sentinel included, or an invalid byte
            (if (i32.ge_u (local.get $digit) (i32.const 64))
              (then
                (return (local.get $offset))
              )
            )

            (local.set $value
              (i32.or
                (local.get $value)
                (i32.shl (i32.and (local.get $digit) (i32.const 31)) (local.get $shift))
              )
            )
            (local.set $shift (i32.add (local.get $shift) (i32.const 5)))
            (br_if $continuation (i32.and (local.get $digit) (i32.const 32)))
          )
        )
      )

      (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
      ;; delta = value & 1 ? -(value >>> 1) : value >>> 1
      (local.set $value
        (select
          (i32.sub (i32.const 0) (i32.shr_u (local.get $value) (i32.const 1)))
          (i32.shr_u (local.get $value) (i32.const 1))
          (i32.and (local.get $value) (i32.const 1))
        )
      )
      (local.set $value (i32.add (local.get $generatedColumn) (local.get $value)))

      ;; PERF: The decisions of a segment take the fields before it, which the fields after the generated column
      ;; still are, so the fields aren't copied for every segment
      (if
        (i32.and
          (i32.ne (local.get $lineSegments) (i32.const 0))
          (i32.lt_s (local.get $value) (local.get $generatedColumn))
        )
        (then
          (i32.store
            (i32.add (local.get $unsortedLines) (i32.shl (local.get $unsortedLineCount) (i32.const 2)))
            (local.get $line)
          )
          (local.set $unsortedLineCount (i32.add (local.get $unsortedLineCount) (i32.const 1)))
        )
      )

      (if
        (i32.or
          (i32.eqz (local.get $lineSegments))
          (i32.and
            (i32.ge_u (local.get $segmentsAfterCheckpoint) (local.get $checkpointSegments))
            (i32.gt_s (local.get $value) (local.get $generatedColumn))
          )
        )
        (then
          (i32.store offset=0 (local.get $checkpointAddr) (local.get $value))
          (i32.store offset=4 (local.get $checkpointAddr) (local.get $generatedColumn))
          (i32.store offset=8 (local.get $checkpointAddr) (i32.add (local.get $start) (local.get $segmentOffset)))
          (i32.store offset=12 (local.get $checkpointAddr) (local.get $source))
          (i32.store offset=16 (local.get $checkpointAddr) (local.get $originalLine))
          (i32.store offset=20 (local.get $checkpointAddr) (local.get $originalColumn))
          (local.set $checkpointAddr (i32.add (local.get $checkpointAddr) (i32.const 24)))
          (local.set $checkpointCount (i32.add (local.get $checkpointCount) (i32.const 1)))
          (local.set $segmentsAfterCheckpoint (i32.const 0))
        )
      )

      (local.set $generatedColumn (local.get $value))
      (local.set $lineSegments (i32.add (local.get $lineSegments) (i32.const 1)))
      (local.set $segmentsAfterCheckpoint (i32.add (local.get $segmentsAfterCheckpoint) (i32.const 1)))

      ;; the fields after the generated column, each by its own copy of the decoding (see PERF above)
      (block $segmentEnd
        (local.set $digit
          (i32.load8_u
            (i32.add
              (local.get $charValues)
              (i32.load8_u (i32.add (local.get $mappings) (local.get $offset)))
            )
          )
        )
        ;; a segment ends with a separator; the byte after the chunk is a separator
        (br_if $segmentEnd (i32.ge_u (local.get $digit) (i32.const 64)))

        ;; the source
        ;; value of the digit at offset, the offset moves after the value's last digit
        (local.set $value (i32.and (local.get $digit) (i32.const 31)))

        (if (i32.and (local.get $digit) (i32.const 32))
          (then
            (local.set $shift (i32.const 5))

            (loop $continuation
              (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
              (local.set $digit
                (i32.load8_u
                  (i32.add
                    (local.get $charValues)
                    (i32.load8_u (i32.add (local.get $mappings) (local.get $offset)))
                  )
                )
              )

              ;; a value can't end with a separator, the sentinel included, or an invalid byte
              (if (i32.ge_u (local.get $digit) (i32.const 64))
                (then
                  (return (local.get $offset))
                )
              )

              (local.set $value
                (i32.or
                  (local.get $value)
                  (i32.shl (i32.and (local.get $digit) (i32.const 31)) (local.get $shift))
                )
              )
              (local.set $shift (i32.add (local.get $shift) (i32.const 5)))
              (br_if $continuation (i32.and (local.get $digit) (i32.const 32)))
            )
          )
        )

        (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
        ;; delta = value & 1 ? -(value >>> 1) : value >>> 1
        (local.set $value
          (select
            (i32.sub (i32.const 0) (i32.shr_u (local.get $value) (i32.const 1)))
            (i32.shr_u (local.get $value) (i32.const 1))
            (i32.and (local.get $value) (i32.const 1))
          )
        )
        (local.set $source (i32.add (local.get $source) (local.get $value)))
        (local.set $digit
          (i32.load8_u
            (i32.add
              (local.get $charValues)
              (i32.load8_u (i32.add (local.get $mappings) (local.get $offset)))
            )
          )
        )
        ;; a segment ends with a separator; the byte after the chunk is a separator
        (br_if $segmentEnd (i32.ge_u (local.get $digit) (i32.const 64)))

        ;; the original line
        ;; value of the digit at offset, the offset moves after the value's last digit
        (local.set $value (i32.and (local.get $digit) (i32.const 31)))

        (if (i32.and (local.get $digit) (i32.const 32))
          (then
            (local.set $shift (i32.const 5))

            (loop $continuation
              (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
              (local.set $digit
                (i32.load8_u
                  (i32.add
                    (local.get $charValues)
                    (i32.load8_u (i32.add (local.get $mappings) (local.get $offset)))
                  )
                )
              )

              ;; a value can't end with a separator, the sentinel included, or an invalid byte
              (if (i32.ge_u (local.get $digit) (i32.const 64))
                (then
                  (return (local.get $offset))
                )
              )

              (local.set $value
                (i32.or
                  (local.get $value)
                  (i32.shl (i32.and (local.get $digit) (i32.const 31)) (local.get $shift))
                )
              )
              (local.set $shift (i32.add (local.get $shift) (i32.const 5)))
              (br_if $continuation (i32.and (local.get $digit) (i32.const 32)))
            )
          )
        )

        (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
        ;; delta = value & 1 ? -(value >>> 1) : value >>> 1
        (local.set $value
          (select
            (i32.sub (i32.const 0) (i32.shr_u (local.get $value) (i32.const 1)))
            (i32.shr_u (local.get $value) (i32.const 1))
            (i32.and (local.get $value) (i32.const 1))
          )
        )
        (local.set $originalLine (i32.add (local.get $originalLine) (local.get $value)))
        (local.set $digit
          (i32.load8_u
            (i32.add
              (local.get $charValues)
              (i32.load8_u (i32.add (local.get $mappings) (local.get $offset)))
            )
          )
        )
        ;; a segment ends with a separator; the byte after the chunk is a separator
        (br_if $segmentEnd (i32.ge_u (local.get $digit) (i32.const 64)))

        ;; the original column
        ;; value of the digit at offset, the offset moves after the value's last digit
        (local.set $value (i32.and (local.get $digit) (i32.const 31)))

        (if (i32.and (local.get $digit) (i32.const 32))
          (then
            (local.set $shift (i32.const 5))

            (loop $continuation
              (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
              (local.set $digit
                (i32.load8_u
                  (i32.add
                    (local.get $charValues)
                    (i32.load8_u (i32.add (local.get $mappings) (local.get $offset)))
                  )
                )
              )

              ;; a value can't end with a separator, the sentinel included, or an invalid byte
              (if (i32.ge_u (local.get $digit) (i32.const 64))
                (then
                  (return (local.get $offset))
                )
              )

              (local.set $value
                (i32.or
                  (local.get $value)
                  (i32.shl (i32.and (local.get $digit) (i32.const 31)) (local.get $shift))
                )
              )
              (local.set $shift (i32.add (local.get $shift) (i32.const 5)))
              (br_if $continuation (i32.and (local.get $digit) (i32.const 32)))
            )
          )
        )

        (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
        ;; delta = value & 1 ? -(value >>> 1) : value >>> 1
        (local.set $value
          (select
            (i32.sub (i32.const 0) (i32.shr_u (local.get $value) (i32.const 1)))
            (i32.shr_u (local.get $value) (i32.const 1))
            (i32.and (local.get $value) (i32.const 1))
          )
        )
        (local.set $originalColumn (i32.add (local.get $originalColumn) (local.get $value)))

        ;; the fields after the original column (a name) aren't used
        (loop $field
          (local.set $digit
            (i32.load8_u
              (i32.add
                (local.get $charValues)
                (i32.load8_u (i32.add (local.get $mappings) (local.get $offset)))
              )
            )
          )
          (br_if $segmentEnd (i32.ge_u (local.get $digit) (i32.const 64)))
          ;; value of the digit at offset, the offset moves after the value's last digit
          (local.set $value (i32.and (local.get $digit) (i32.const 31)))

          (if (i32.and (local.get $digit) (i32.const 32))
            (then
              (local.set $shift (i32.const 5))

              (loop $continuation
                (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
                (local.set $digit
                  (i32.load8_u
                    (i32.add
                      (local.get $charValues)
                      (i32.load8_u (i32.add (local.get $mappings) (local.get $offset)))
                    )
                  )
                )

                ;; a value can't end with a separator, the sentinel included, or an invalid byte
                (if (i32.ge_u (local.get $digit) (i32.const 64))
                  (then
                    (return (local.get $offset))
                  )
                )

                (local.set $value
                  (i32.or
                    (local.get $value)
                    (i32.shl (i32.and (local.get $digit) (i32.const 31)) (local.get $shift))
                  )
                )
                (local.set $shift (i32.add (local.get $shift) (i32.const 5)))
                (br_if $continuation (i32.and (local.get $digit) (i32.const 32)))
              )
            )
          )

          (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
          ;; delta = value & 1 ? -(value >>> 1) : value >>> 1
          (local.set $value
            (select
              (i32.sub (i32.const 0) (i32.shr_u (local.get $value) (i32.const 1)))
              (i32.shr_u (local.get $value) (i32.const 1))
              (i32.and (local.get $value) (i32.const 1))
            )
          )
          (br $field)
        )
      )

      (if (i32.eq (local.get $digit) (i32.const 255))
        (then
          (return (local.get $offset))
        )
      )

      (br $loop)
    )
  )

  (i32.store offset=0 (local.get $state) (local.get $line))
  (i32.store offset=4 (local.get $state) (local.get $lineSegments))
  (i32.store offset=8 (local.get $state) (local.get $segmentsAfterCheckpoint))
  (i32.store offset=12 (local.get $state) (local.get $generatedColumn))
  (i32.store offset=16 (local.get $state) (local.get $source))
  (i32.store offset=20 (local.get $state) (local.get $originalLine))
  (i32.store offset=24 (local.get $state) (local.get $originalColumn))
  (i32.store offset=28 (local.get $state) (local.get $checkpointCount))
  (i32.store offset=32 (local.get $state) (local.get $unsortedLineCount))

  (i32.const -1)
)
