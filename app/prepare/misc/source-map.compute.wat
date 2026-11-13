(import "imports" "memory" (memory 0))

;; The index pass of a source map over a chunk of its mappings (source-map.compute.ts): segments are decoded,
;; a checkpoint (6 x i32: column, previous column, offset, source, original line, original column) is written
;; at the start of a line and before a segment after several segments, the first checkpoint of each line the chunk
;; starts at lineCheckpoints, a line with a segment before the previous one's column at unsortedLines. The chunk
;; ends after a separator or with the mappings; the state of decoding carries over chunks at state (7 x i32: line,
;; segments of the line, segments after the last checkpoint, generated column, source, original line, original
;; column), followed by the checkpoint count of the mappings and the unsorted line count of the chunk. A byte
;; of the mappings has its value at charValues: a base64 digit, 254 for a separator, 255 for an invalid byte.
;; Returns -1, or the offset of an invalid byte in the chunk
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
  (local $delta i32)
  (local $fieldCount i32)
  (local $line i32)
  (local $lineSegments i32)
  (local $segmentsAfterCheckpoint i32)
  (local $generatedColumn i32)
  (local $source i32)
  (local $originalLine i32)
  (local $originalColumn i32)
  (local $previousColumn i32)
  (local $previousSource i32)
  (local $previousOriginalLine i32)
  (local $previousOriginalColumn i32)
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
  ;;   a segment is decoded into the fields, the line is unsorted when its column goes back,
  ;;   a checkpoint is written at the start of a line and after several segments at a greater column
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
      (local.set $previousColumn (local.get $generatedColumn))
      (local.set $previousSource (local.get $source))
      (local.set $previousOriginalLine (local.get $originalLine))
      (local.set $previousOriginalColumn (local.get $originalColumn))
      (local.set $fieldCount (i32.const 0))
      (local.set $digit (i32.load8_u (i32.add (local.get $charValues) (local.get $digit))))

      ;; a segment is a sequence of base64 VLQ values up to a separator or the end of the chunk
      (block $segmentEnd
        (loop $segment
          (br_if $segmentEnd (i32.ge_u (local.get $digit) (i32.const 64)))

          (local.set $value (i32.and (local.get $digit) (i32.const 31)))
          (local.set $shift (i32.const 5))

          ;; a digit with the continuation bit is followed by more digits of the value
          (block $valueEnd
            (loop $continuation
              (br_if $valueEnd (i32.eqz (i32.and (local.get $digit) (i32.const 32))))

              (local.set $offset (i32.add (local.get $offset) (i32.const 1)))

              (if (i32.ge_u (local.get $offset) (local.get $size))
                (then
                  (return (local.get $offset))
                )
              )

              (local.set $digit
                (i32.load8_u
                  (i32.add
                    (local.get $charValues)
                    (i32.load8_u (i32.add (local.get $mappings) (local.get $offset)))
                  )
                )
              )

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
              (br $continuation)
            )
          )

          ;; delta = value & 1 ? -(value >>> 1) : value >>> 1
          (local.set $delta
            (select
              (i32.sub (i32.const 0) (i32.shr_u (local.get $value) (i32.const 1)))
              (i32.shr_u (local.get $value) (i32.const 1))
              (i32.and (local.get $value) (i32.const 1))
            )
          )

          ;; the fields after the original column (a name) aren't used
          (block $fieldEnd
            (block $originalColumnField
              (block $originalLineField
                (block $sourceField
                  (block $generatedColumnField
                    (br_table
                      $generatedColumnField
                      $sourceField
                      $originalLineField
                      $originalColumnField
                      $fieldEnd
                      (local.get $fieldCount)
                    )
                  )
                  (local.set $generatedColumn (i32.add (local.get $generatedColumn) (local.get $delta)))
                  (br $fieldEnd)
                )
                (local.set $source (i32.add (local.get $source) (local.get $delta)))
                (br $fieldEnd)
              )
              (local.set $originalLine (i32.add (local.get $originalLine) (local.get $delta)))
              (br $fieldEnd)
            )
            (local.set $originalColumn (i32.add (local.get $originalColumn) (local.get $delta)))
          )

          (local.set $fieldCount (i32.add (local.get $fieldCount) (i32.const 1)))
          (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
          (local.set $digit (i32.const 254))

          (if (i32.lt_u (local.get $offset) (local.get $size))
            (then
              (local.set $digit
                (i32.load8_u
                  (i32.add
                    (local.get $charValues)
                    (i32.load8_u (i32.add (local.get $mappings) (local.get $offset)))
                  )
                )
              )
            )
          )

          (br $segment)
        )
      )

      (if (i32.eq (local.get $digit) (i32.const 255))
        (then
          (return (local.get $offset))
        )
      )

      (if
        (i32.and
          (i32.ne (local.get $lineSegments) (i32.const 0))
          (i32.lt_s (local.get $generatedColumn) (local.get $previousColumn))
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
            (i32.gt_s (local.get $generatedColumn) (local.get $previousColumn))
          )
        )
        (then
          (i32.store offset=0 (local.get $checkpointAddr) (local.get $generatedColumn))
          (i32.store offset=4 (local.get $checkpointAddr) (local.get $previousColumn))
          (i32.store offset=8 (local.get $checkpointAddr) (i32.add (local.get $start) (local.get $segmentOffset)))
          (i32.store offset=12 (local.get $checkpointAddr) (local.get $previousSource))
          (i32.store offset=16 (local.get $checkpointAddr) (local.get $previousOriginalLine))
          (i32.store offset=20 (local.get $checkpointAddr) (local.get $previousOriginalColumn))
          (local.set $checkpointAddr (i32.add (local.get $checkpointAddr) (i32.const 24)))
          (local.set $checkpointCount (i32.add (local.get $checkpointCount) (i32.const 1)))
          (local.set $segmentsAfterCheckpoint (i32.const 0))
        )
      )

      (local.set $lineSegments (i32.add (local.get $lineSegments) (i32.const 1)))
      (local.set $segmentsAfterCheckpoint (i32.add (local.get $segmentsAfterCheckpoint) (i32.const 1)))
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
