(import "imports" "memory" (memory 0))

;; Ids of combinations of the ids of earlier columns with the values of more columns, for a chunk of events staged
;; into the buffer. A dense table maps an id and values (row-major) to the id of their combination, or -1; a missing
;; combination takes the next id, count, and its first event is written at firstEvents[id - (count at the call)].
;; A pass returns the count after the chunk. The table is i32 (4 bytes), first events are u32 (4 bytes); ids
;; and values of columns given per event are elements of 1, 2 or 4 bytes (a step), read as 4 bytes and masked.
;; Ids are written as 4 bytes at their address whatever their step: the bytes past a 2-byte id go to the next one,
;; which is written after it, and the buffer has room after the last one

;; Combines ids with the values of three columns given per event; fewer columns are combined with columns of zeros
;; of size 1 before them
(func $combineEventColumns (export "combineEventColumns")
  (param $size i32)
  (param $sourceIds i32)
  (param $sourceStep i32)
  (param $sourceMask i32)
  (param $first i32)
  (param $firstStep i32)
  (param $firstMask i32)
  (param $second i32)
  (param $secondStep i32)
  (param $secondMask i32)
  (param $third i32)
  (param $thirdStep i32)
  (param $thirdMask i32)
  (param $secondSize i32)
  (param $thirdSize i32)
  (param $valuesSize i32) ;; Number of combinations of the values, the size of a row of the table.
  (param $table i32)
  (param $ids i32)
  (param $idsStep i32)
  (param $firstEvents i32)
  (param $count i32)
  (result i32)
  (local $idsStart i32)
  (local $idsEnd i32)
  (local $entry i32) ;; Address of the table entry of the event.
  (local $id i32)
  (local $firstId i32)

  ;; for (let i = 0; i < size; i++) {
  ;;   entry = sourceIds[i] * valuesSize + (first[i] * secondSize + second[i]) * thirdSize + third[i]
  ;;   ids[i] = table[entry], the next id when missing
  ;; }
  ;; Addresses of the elements of an event are stepped by their widths, the event's index is (ids - idsStart) / idsStep

  (local.set $idsStart (local.get $ids))
  (local.set $idsEnd (i32.add (local.get $ids) (i32.mul (local.get $size) (local.get $idsStep))))
  (local.set $firstId (local.get $count))

  ;; PERF: A missing combination leaves the loop of found ones and the loop resumes after it's added, so values used
  ;; only to add a combination don't take registers in the loop; with them there, steps and masks are spilled
  ;; and reloaded per event
  (block $exit
    (loop $resume
      (block $missing
        (loop $found
          (br_if $exit (i32.eq (local.get $ids) (local.get $idsEnd)))

          ;; entry = table + (sourceIds[i] * valuesSize + (first[i] * secondSize + second[i]) * thirdSize
          ;;   + third[i]) * 4
          (local.set $entry
            (i32.add
              (local.get $table)
              (i32.shl
                (i32.add
                  (i32.mul
                    (i32.and (i32.load (local.get $sourceIds)) (local.get $sourceMask))
                    (local.get $valuesSize)
                  )
                  (i32.add
                    (i32.mul
                      (i32.add
                        (i32.mul
                          (i32.and (i32.load (local.get $first)) (local.get $firstMask))
                          (local.get $secondSize)
                        )
                        (i32.and (i32.load (local.get $second)) (local.get $secondMask))
                      )
                      (local.get $thirdSize)
                    )
                    (i32.and (i32.load (local.get $third)) (local.get $thirdMask))
                  )
                )
                (i32.const 2)
              )
            )
          )

          ;; if ((id = table[entry]) === -1) the combination is missing
          (br_if $missing (i32.eq (local.tee $id (i32.load (local.get $entry))) (i32.const -1)))

          ;; ids[i] = id
          (i32.store (local.get $ids) (local.get $id))

          (local.set $sourceIds (i32.add (local.get $sourceIds) (local.get $sourceStep)))
          (local.set $first (i32.add (local.get $first) (local.get $firstStep)))
          (local.set $second (i32.add (local.get $second) (local.get $secondStep)))
          (local.set $third (i32.add (local.get $third) (local.get $thirdStep)))
          (local.set $ids (i32.add (local.get $ids) (local.get $idsStep)))
          (br $found)
        )
      )

      ;; table[entry] = id = count++
      (local.set $id (local.get $count))
      (local.set $count (i32.add (local.get $count) (i32.const 1)))
      (i32.store (local.get $entry) (local.get $id))
      ;; firstEvents[id - firstId] = i
      (i32.store
        (i32.add (local.get $firstEvents) (i32.shl (i32.sub (local.get $id) (local.get $firstId)) (i32.const 2)))
        (i32.div_u (i32.sub (local.get $ids) (local.get $idsStart)) (local.get $idsStep))
      )
      ;; ids[i] = id
      (i32.store (local.get $ids) (local.get $id))

      (local.set $sourceIds (i32.add (local.get $sourceIds) (local.get $sourceStep)))
      (local.set $first (i32.add (local.get $first) (local.get $firstStep)))
      (local.set $second (i32.add (local.get $second) (local.get $secondStep)))
      (local.set $third (i32.add (local.get $third) (local.get $thirdStep)))
      (local.set $ids (i32.add (local.get $ids) (local.get $idsStep)))
      (br $resume)
    )
  )

  (local.get $count)
)

;; Combines ids with the values of two columns given per sample: the value of an event is the value of its sample,
;; keys[samples[i]], keys and samples are u32. One column is combined with a column of zeros of size 1 before it:
;; samples of zeros and keys of a zero
(func $combineSampleColumns (export "combineSampleColumns")
  (param $size i32)
  (param $sourceIds i32)
  (param $sourceStep i32)
  (param $sourceMask i32)
  (param $leftSamples i32)
  (param $leftKeys i32)
  (param $rightSamples i32)
  (param $rightKeys i32)
  (param $rightSize i32)
  (param $valuesSize i32) ;; Number of combinations of the values, the size of a row of the table.
  (param $table i32)
  (param $ids i32)
  (param $idsStep i32)
  (param $firstEvents i32)
  (param $count i32)
  (result i32)
  (local $idsStart i32)
  (local $idsEnd i32)
  (local $entry i32) ;; Address of the table entry of the event.
  (local $id i32)
  (local $firstId i32)

  ;; for (let i = 0; i < size; i++) {
  ;;   entry = sourceIds[i] * valuesSize + leftKeys[leftSamples[i]] * rightSize + rightKeys[rightSamples[i]]
  ;;   ids[i] = table[entry], the next id when missing
  ;; }

  (local.set $idsStart (local.get $ids))
  (local.set $idsEnd (i32.add (local.get $ids) (i32.mul (local.get $size) (local.get $idsStep))))
  (local.set $firstId (local.get $count))

  ;; PERF: Reading the keys of samples in the pass costs less than staging them as columns given per event, a write
  ;; and a read of the chunk per column; a missing combination leaves the loop of found ones as in combineEventColumns
  (block $exit
    (loop $resume
      (block $missing
        (loop $found
          (br_if $exit (i32.eq (local.get $ids) (local.get $idsEnd)))

          ;; entry = table + (sourceIds[i] * valuesSize + leftKeys[leftSamples[i]] * rightSize
          ;;   + rightKeys[rightSamples[i]]) * 4
          (local.set $entry
            (i32.add
              (local.get $table)
              (i32.shl
                (i32.add
                  (i32.mul
                    (i32.and (i32.load (local.get $sourceIds)) (local.get $sourceMask))
                    (local.get $valuesSize)
                  )
                  (i32.add
                    (i32.mul
                      (i32.load
                        (i32.add (local.get $leftKeys) (i32.shl (i32.load (local.get $leftSamples)) (i32.const 2)))
                      )
                      (local.get $rightSize)
                    )
                    (i32.load
                      (i32.add (local.get $rightKeys) (i32.shl (i32.load (local.get $rightSamples)) (i32.const 2)))
                    )
                  )
                )
                (i32.const 2)
              )
            )
          )

          ;; if ((id = table[entry]) === -1) the combination is missing
          (br_if $missing (i32.eq (local.tee $id (i32.load (local.get $entry))) (i32.const -1)))

          ;; ids[i] = id
          (i32.store (local.get $ids) (local.get $id))

          (local.set $sourceIds (i32.add (local.get $sourceIds) (local.get $sourceStep)))
          (local.set $leftSamples (i32.add (local.get $leftSamples) (i32.const 4)))
          (local.set $rightSamples (i32.add (local.get $rightSamples) (i32.const 4)))
          (local.set $ids (i32.add (local.get $ids) (local.get $idsStep)))
          (br $found)
        )
      )

      ;; table[entry] = id = count++
      (local.set $id (local.get $count))
      (local.set $count (i32.add (local.get $count) (i32.const 1)))
      (i32.store (local.get $entry) (local.get $id))
      ;; firstEvents[id - firstId] = i
      (i32.store
        (i32.add (local.get $firstEvents) (i32.shl (i32.sub (local.get $id) (local.get $firstId)) (i32.const 2)))
        (i32.div_u (i32.sub (local.get $ids) (local.get $idsStart)) (local.get $idsStep))
      )
      ;; ids[i] = id
      (i32.store (local.get $ids) (local.get $id))

      (local.set $sourceIds (i32.add (local.get $sourceIds) (local.get $sourceStep)))
      (local.set $leftSamples (i32.add (local.get $leftSamples) (i32.const 4)))
      (local.set $rightSamples (i32.add (local.get $rightSamples) (i32.const 4)))
      (local.set $ids (i32.add (local.get $ids) (local.get $idsStep)))
      (br $resume)
    )
  )

  (local.get $count)
)
