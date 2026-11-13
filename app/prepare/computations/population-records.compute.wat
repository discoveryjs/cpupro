(import "imports" "memory" (memory 0))

;; Records of a part of a population: an event adds its value to the record of its sample and class. Records are
;; numbered from firstRecord; a record of the part is at its number minus firstRecord in recordSamples,
;; recordClasses, recordWeights and recordCounts. Numbers below firstRecord in the tables belong to earlier parts
;; and are free, so the tables need no clearing. Samples, values and counts are u32 (4 bytes), weights f64 (8 bytes);
;; classes are elements of classStep bytes, read as 4 bytes and masked by classMask. A pass writes the number of runs
;; of one sample at runs and of events with a nonzero value at nonzero, and returns the number of records

;; A new record of a sample and a class at an index of the records of the part
(func $addRecord
  (param $recordIndex i32)
  (param $sample i32)
  (param $class i32)
  (param $recordSamples i32)
  (param $recordClasses i32)
  (param $recordWeights i32)
  (param $recordCounts i32)
  (local $addr i32)

  (local.set $addr (i32.shl (local.get $recordIndex) (i32.const 2)))
  (i32.store (i32.add (local.get $recordSamples) (local.get $addr)) (local.get $sample))
  (i32.store (i32.add (local.get $recordClasses) (local.get $addr)) (local.get $class))
  (i32.store (i32.add (local.get $recordCounts) (local.get $addr)) (i32.const 0))
  (i64.store (i32.add (local.get $recordWeights) (i32.shl (local.get $recordIndex) (i32.const 3))) (i64.const 0))
)

;; Adds a nonzero value to a record of the part. Weights are summed as i64 and converted to f64 when the part is done,
;; since an integer add keeps the add-store-load chain of consecutive events of one record short
(func $addValue
  (param $recordIndex i32)
  (param $value i32)
  (param $recordWeights i32)
  (param $recordCounts i32)
  (local $addr i32)

  (local.set $addr (i32.add (local.get $recordWeights) (i32.shl (local.get $recordIndex) (i32.const 3))))
  (i64.store (local.get $addr) (i64.add (i64.load (local.get $addr)) (i64.extend_i32_u (local.get $value))))
  (local.set $addr (i32.add (local.get $recordCounts) (i32.shl (local.get $recordIndex) (i32.const 2))))
  (i32.store (local.get $addr) (i32.add (i32.load (local.get $addr)) (i32.const 1)))
)

;; Weights of the records of a part summed as i64 become f64; returns the sum of their counts, the number of events
;; of the part with a nonzero value
(func $finishRecords
  (param $recordWeights i32)
  (param $recordCounts i32)
  (param $count i32)
  (result i32)
  (local $addr i32)
  (local $end i32)
  (local $countAddr i32)
  (local $nonzero i32)

  (local.set $addr (local.get $recordWeights))
  (local.set $end (i32.add (local.get $recordWeights) (i32.shl (local.get $count) (i32.const 3))))
  (local.set $countAddr (local.get $recordCounts))

  (block $exit
    (loop $loop
      (br_if $exit (i32.eq (local.get $addr) (local.get $end)))
      (f64.store (local.get $addr) (f64.convert_i64_u (i64.load (local.get $addr))))
      (local.set $nonzero (i32.add (local.get $nonzero) (i32.load (local.get $countAddr))))
      (local.set $addr (i32.add (local.get $addr) (i32.const 8)))
      (local.set $countAddr (i32.add (local.get $countAddr) (i32.const 4)))
      (br $loop)
    )
  )

  (local.get $nonzero)
)

;; A hash table with linear probing finds the record of an event's sample and class; consecutive events of one
;; sample and class take the record without a lookup
(func $groupPairs (export "groupPairs")
  (param $size i32)
  (param $samples i32)
  (param $classes i32)
  (param $classStep i32)
  (param $classMask i32)
  (param $values i32)
  (param $slots i32)
  (param $slotMask i32)
  (param $recordSamples i32)
  (param $recordClasses i32)
  (param $recordWeights i32)
  (param $recordCounts i32)
  (param $firstRecord i32)
  (param $runs i32)
  (param $nonzero i32)
  (result i32)
  (local $samplesAddr i32) ;; Addresses of the event in samples, classes and values.
  (local $classesAddr i32)
  (local $valuesAddr i32)
  (local $samplesEnd i32)
  (local $sample i32)
  (local $class i32)
  (local $value i32)
  (local $previousSample i32)
  (local $previousClass i32)
  (local $slot i32)
  (local $record i32)
  (local $recordIndex i32)
  (local $recordAddr i32)
  (local $count i32)
  (local $runCount i32)

  ;; for (let i = 0; i < size; i++) {
  ;;   if (the sample or the class differs from the previous event's) {
  ;;     record = the record of (sample, class), added when missing
  ;;   }
  ;;   if (value !== 0) {
  ;;     recordWeights[record] += value;
  ;;     recordCounts[record]++;
  ;;   }
  ;; }

  ;; $previousSample = -1, $previousClass = -1: the first event differs from any
  (local.set $previousSample (i32.const -1))
  (local.set $previousClass (i32.const -1))

  ;; the first event, $samplesEnd = $samples + ($size << 2) past the last one
  (local.set $samplesAddr (local.get $samples))
  (local.set $classesAddr (local.get $classes))
  (local.set $valuesAddr (local.get $values))
  (local.set $samplesEnd (i32.add (local.get $samples) (i32.shl (local.get $size) (i32.const 2))))

  (if (local.get $size)
  (then
    (loop $loop
      ;; $sample = samples[i]
      (local.set $sample (i32.load (local.get $samplesAddr)))
      ;; $class = classes[i]: 4 bytes at its address, the bytes after the element masked
      (local.set $class (i32.and (i32.load (local.get $classesAddr)) (local.get $classMask)))
      ;; $value = values[i]
      (local.set $value (i32.load (local.get $valuesAddr)))

      ;; if ($sample !== $previousSample || $class !== $previousClass)
      (if
        (i32.or
          (i32.ne (local.get $sample) (local.get $previousSample))
          (i32.ne (local.get $class) (local.get $previousClass))
        )
        (then
          ;; $runCount += $sample !== $previousSample ? 1 : 0, the comparison is 0 or 1
          (local.set $runCount
            (i32.add (local.get $runCount) (i32.ne (local.get $sample) (local.get $previousSample)))
          )
          ;; $previousSample = $sample, $previousClass = $class
          (local.set $previousSample (local.get $sample))
          (local.set $previousClass (local.get $class))
          ;; $slot = (imul($sample, 0x9e3779b1) ^ imul($class + 0x7f4a7c15, 0x85ebca6b)) & $slotMask
          (local.set $slot
            (i32.and
              (i32.xor
                (i32.mul (local.get $sample) (i32.const 0x9e3779b1))
                (i32.mul (i32.add (local.get $class) (i32.const 0x7f4a7c15)) (i32.const 0x85ebca6b))
              )
              (local.get $slotMask)
            )
          )
          ;; $record = slots[$slot], at $slots + ($slot << 2)
          (local.set $record (i32.load (i32.add (local.get $slots) (i32.shl (local.get $slot) (i32.const 2)))))

          (block $found
            (loop $probe
              ;; a missing record is added as the next one at the free slot:
              ;; if ($record < $firstRecord), a slot of an earlier part or never taken (-1)
              (if (i32.lt_s (local.get $record) (local.get $firstRecord))
                (then
                  ;; addRecord($count, ...): the record of the part at index $count
                  (call $addRecord
                    (local.get $count)
                    (local.get $sample)
                    (local.get $class)
                    (local.get $recordSamples)
                    (local.get $recordClasses)
                    (local.get $recordWeights)
                    (local.get $recordCounts)
                  )
                  ;; $record = $firstRecord + $count++
                  (local.set $record (i32.add (local.get $firstRecord) (local.get $count)))
                  (local.set $count (i32.add (local.get $count) (i32.const 1)))
                  ;; slots[$slot] = $record
                  (i32.store (i32.add (local.get $slots) (i32.shl (local.get $slot) (i32.const 2))) (local.get $record))
                  (br $found)
                )
              )

              ;; $recordAddr = ($record - $firstRecord) << 2, the byte offset of the record of the part
              (local.set $recordAddr
                (i32.shl (i32.sub (local.get $record) (local.get $firstRecord)) (i32.const 2))
              )

              ;; if (recordSamples[$record - $firstRecord] === $sample
              ;;   && recordClasses[$record - $firstRecord] === $class) found, both compared without short-circuit
              (br_if $found
                (i32.and
                  (i32.eq (i32.load (i32.add (local.get $recordSamples) (local.get $recordAddr))) (local.get $sample))
                  (i32.eq (i32.load (i32.add (local.get $recordClasses) (local.get $recordAddr))) (local.get $class))
                )
              )

              ;; $slot = ($slot + 1) & $slotMask
              (local.set $slot (i32.and (i32.add (local.get $slot) (i32.const 1)) (local.get $slotMask)))
              ;; $record = slots[$slot]
              (local.set $record (i32.load (i32.add (local.get $slots) (i32.shl (local.get $slot) (i32.const 2)))))
              (br $probe)
            )
          )

          ;; $recordIndex = $record - $firstRecord, kept for the next events of the sample and class
          (local.set $recordIndex (i32.sub (local.get $record) (local.get $firstRecord)))
        )
      )

      ;; if ($value !== 0) addValue($recordIndex, $value)
      (if (local.get $value)
        (then
          (call $addValue
            (local.get $recordIndex)
            (local.get $value)
            (local.get $recordWeights)
            (local.get $recordCounts)
          )
        )
      )

      ;; the next event
      (local.set $samplesAddr (i32.add (local.get $samplesAddr) (i32.const 4)))
      (local.set $classesAddr (i32.add (local.get $classesAddr) (local.get $classStep)))
      (local.set $valuesAddr (i32.add (local.get $valuesAddr) (i32.const 4)))
      ;; while ($samplesAddr !== $samplesEnd)
      (br_if $loop (i32.ne (local.get $samplesAddr) (local.get $samplesEnd)))
    )
  )
  )

  ;; runs[0] = $runCount, nonzero[0] = the number of events with a nonzero value
  (i32.store (local.get $runs) (local.get $runCount))
  (i32.store
    (local.get $nonzero)
    (call $finishRecords (local.get $recordWeights) (local.get $recordCounts) (local.get $count))
  )

  (local.get $count)
)

;; Within a run of one sample a dense table by class holds the record of each class; a record numbered before
;; the run's first record belongs to another run, so a sample recurring in the part takes records of its own
;; for every run
(func $groupRuns (export "groupRuns")
  (param $size i32)
  (param $samples i32)
  (param $classes i32)
  (param $classStep i32)
  (param $classMask i32)
  (param $values i32)
  (param $classRecords i32)
  (param $recordSamples i32)
  (param $recordClasses i32)
  (param $recordWeights i32)
  (param $recordCounts i32)
  (param $firstRecord i32)
  (param $runs i32)
  (param $nonzero i32)
  (result i32)
  (local $samplesAddr i32) ;; Addresses of the event in samples, classes and values.
  (local $classesAddr i32)
  (local $valuesAddr i32)
  (local $samplesEnd i32)
  (local $sample i32)
  (local $class i32)
  (local $value i32)
  (local $previousSample i32)
  (local $runFirstRecord i32)
  (local $classAddr i32)
  (local $record i32)
  (local $count i32)
  (local $runCount i32)

  ;; for (let i = 0; i < size; i++) {
  ;;   if (the sample differs from the previous event's) a run starts with the next record
  ;;   record = classRecords[class], added when it's before the run
  ;;   if (value !== 0) {
  ;;     recordWeights[record] += value;
  ;;     recordCounts[record]++;
  ;;   }
  ;; }

  ;; $previousSample = -1: the first event starts a run
  (local.set $previousSample (i32.const -1))

  ;; the first event, $samplesEnd = $samples + ($size << 2) past the last one
  (local.set $samplesAddr (local.get $samples))
  (local.set $classesAddr (local.get $classes))
  (local.set $valuesAddr (local.get $values))
  (local.set $samplesEnd (i32.add (local.get $samples) (i32.shl (local.get $size) (i32.const 2))))

  (if (local.get $size)
  (then
    (loop $loop
      ;; $sample = samples[i]
      (local.set $sample (i32.load (local.get $samplesAddr)))
      ;; $class = classes[i]: 4 bytes at its address, the bytes after the element masked
      (local.set $class (i32.and (i32.load (local.get $classesAddr)) (local.get $classMask)))
      ;; $value = values[i]
      (local.set $value (i32.load (local.get $valuesAddr)))

      ;; if ($sample !== $previousSample) a run starts:
      ;; $runFirstRecord = $firstRecord + $count, $previousSample = $sample, $runCount++
      (if (i32.ne (local.get $sample) (local.get $previousSample))
        (then
          (local.set $runFirstRecord (i32.add (local.get $firstRecord) (local.get $count)))
          (local.set $previousSample (local.get $sample))
          (local.set $runCount (i32.add (local.get $runCount) (i32.const 1)))
        )
      )

      ;; $record = classRecords[$class], at $classAddr = $classRecords + ($class << 2)
      (local.set $classAddr (i32.add (local.get $classRecords) (i32.shl (local.get $class) (i32.const 2))))
      (local.set $record (i32.load (local.get $classAddr)))

      ;; if ($record < $runFirstRecord), a record of another run or of an earlier part (-1 when never taken)
      (if (i32.lt_s (local.get $record) (local.get $runFirstRecord))
        (then
          ;; addRecord($count, ...): the record of the part at index $count
          (call $addRecord
            (local.get $count)
            (local.get $sample)
            (local.get $class)
            (local.get $recordSamples)
            (local.get $recordClasses)
            (local.get $recordWeights)
            (local.get $recordCounts)
          )
          ;; $record = $firstRecord + $count++
          (local.set $record (i32.add (local.get $firstRecord) (local.get $count)))
          (local.set $count (i32.add (local.get $count) (i32.const 1)))
          ;; classRecords[$class] = $record
          (i32.store (local.get $classAddr) (local.get $record))
        )
      )

      ;; if ($value !== 0) addValue($record - $firstRecord, $value)
      (if (local.get $value)
        (then
          (call $addValue
            (i32.sub (local.get $record) (local.get $firstRecord))
            (local.get $value)
            (local.get $recordWeights)
            (local.get $recordCounts)
          )
        )
      )

      ;; the next event
      (local.set $samplesAddr (i32.add (local.get $samplesAddr) (i32.const 4)))
      (local.set $classesAddr (i32.add (local.get $classesAddr) (local.get $classStep)))
      (local.set $valuesAddr (i32.add (local.get $valuesAddr) (i32.const 4)))
      ;; while ($samplesAddr !== $samplesEnd)
      (br_if $loop (i32.ne (local.get $samplesAddr) (local.get $samplesEnd)))
    )
  )
  )

  ;; runs[0] = $runCount, nonzero[0] = the number of events with a nonzero value
  (i32.store (local.get $runs) (local.get $runCount))
  (i32.store
    (local.get $nonzero)
    (call $finishRecords (local.get $recordWeights) (local.get $recordCounts) (local.get $count))
  )

  (local.get $count)
)
