(import "imports" "memory" (memory 0))

;; Records of a part of a population: an event adds its value to the record of its sample and class. Records are
;; numbered from firstRecord; a record of the part is at its number minus firstRecord in recordSamples,
;; recordClasses, recordWeights and recordCounts. Numbers below firstRecord in the tables belong to earlier parts
;; and are free, so the tables need no clearing. Samples, values and counts are u32 (4 bytes), weights f64 (8 bytes);
;; classes are elements of classStep bytes, read as 4 bytes and masked by classMask. A pass writes the number of runs
;; of one sample at runs and of events with a nonzero value at nonzero, and returns the number of records.
;; PERF: The passes address the vectors of records by record numbers, from their starts moved back by firstRecord
;; elements (i32 addresses wrap, so a moved start may be below 0), so no event subtracts firstRecord

;; A new record of a sample and a class
(func $addRecord
  (param $record i32)
  (param $sample i32)
  (param $class i32)
  (param $samplesOfRecords i32)
  (param $classesOfRecords i32)
  (param $weightsOfRecords i32)
  (param $countsOfRecords i32)
  (local $addr i32)

  (local.set $addr (i32.shl (local.get $record) (i32.const 2)))
  (i32.store (i32.add (local.get $samplesOfRecords) (local.get $addr)) (local.get $sample))
  (i32.store (i32.add (local.get $classesOfRecords) (local.get $addr)) (local.get $class))
  (i32.store (i32.add (local.get $countsOfRecords) (local.get $addr)) (i32.const 0))
  (i64.store (i32.add (local.get $weightsOfRecords) (i32.shl (local.get $record) (i32.const 3))) (i64.const 0))
)

;; Adds a nonzero value to a record. Weights are summed as i64 and converted to f64 when the part is done, since
;; an integer add keeps the add-store-load chain of events of one record short
(func $addValue
  (param $record i32)
  (param $value i32)
  (param $weightsOfRecords i32)
  (param $countsOfRecords i32)
  (local $addr i32)

  (local.set $addr (i32.add (local.get $weightsOfRecords) (i32.shl (local.get $record) (i32.const 3))))
  (i64.store (local.get $addr) (i64.add (i64.load (local.get $addr)) (i64.extend_i32_u (local.get $value))))
  (local.set $addr (i32.add (local.get $countsOfRecords) (i32.shl (local.get $record) (i32.const 2))))
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

;; A hash table with linear probing finds the record of an event's sample and class
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
  (local $samplesOfRecords i32) ;; Starts of the vectors of records moved back by firstRecord elements.
  (local $classesOfRecords i32)
  (local $weightsOfRecords i32)
  (local $countsOfRecords i32)
  (local $sample i32)
  (local $class i32)
  (local $value i32)
  (local $previousSample i32)
  (local $slot i32)
  (local $record i32)
  (local $nextRecord i32)
  (local $runCount i32)

  ;; for (let i = 0; i < size; i++) {
  ;;   record = the record of (sample, class), added when missing
  ;;   if (value !== 0) {
  ;;     recordWeights[record] += value;
  ;;     recordCounts[record]++;
  ;;   }
  ;; }

  ;; $samplesOfRecords = $recordSamples - ($firstRecord << 2), and so on: a record numbered n is at n << 2 (n << 3)
  (local.set $samplesOfRecords (i32.sub (local.get $recordSamples) (i32.shl (local.get $firstRecord) (i32.const 2))))
  (local.set $classesOfRecords (i32.sub (local.get $recordClasses) (i32.shl (local.get $firstRecord) (i32.const 2))))
  (local.set $weightsOfRecords (i32.sub (local.get $recordWeights) (i32.shl (local.get $firstRecord) (i32.const 3))))
  (local.set $countsOfRecords (i32.sub (local.get $recordCounts) (i32.shl (local.get $firstRecord) (i32.const 2))))
  ;; $nextRecord = $firstRecord: the number of the next record added
  (local.set $nextRecord (local.get $firstRecord))
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

      ;; $runCount += $sample !== $previousSample ? 1 : 0, the comparison is 0 or 1
      (local.set $runCount (i32.add (local.get $runCount) (i32.ne (local.get $sample) (local.get $previousSample))))
      (local.set $previousSample (local.get $sample))

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

      (block $found
        (loop $probe
          ;; $record = slots[$slot]
          (local.set $record (i32.load (i32.add (local.get $slots) (i32.shl (local.get $slot) (i32.const 2)))))

          ;; a missing record is added as the next one at the free slot:
          ;; if ($record < $firstRecord), a slot of an earlier part or never taken (-1)
          (if (i32.lt_s (local.get $record) (local.get $firstRecord))
            (then
              ;; $record = $nextRecord++
              (local.set $record (local.get $nextRecord))
              (local.set $nextRecord (i32.add (local.get $nextRecord) (i32.const 1)))
              (call $addRecord
                (local.get $record)
                (local.get $sample)
                (local.get $class)
                (local.get $samplesOfRecords)
                (local.get $classesOfRecords)
                (local.get $weightsOfRecords)
                (local.get $countsOfRecords)
              )
              ;; slots[$slot] = $record
              (i32.store (i32.add (local.get $slots) (i32.shl (local.get $slot) (i32.const 2))) (local.get $record))
              (br $found)
            )
          )

          ;; if (samplesOfRecords[$record] === $sample && classesOfRecords[$record] === $class) found,
          ;; both compared without short-circuit
          (br_if $found
            (i32.and
              (i32.eq
                (i32.load (i32.add (local.get $samplesOfRecords) (i32.shl (local.get $record) (i32.const 2))))
                (local.get $sample)
              )
              (i32.eq
                (i32.load (i32.add (local.get $classesOfRecords) (i32.shl (local.get $record) (i32.const 2))))
                (local.get $class)
              )
            )
          )

          ;; $slot = ($slot + 1) & $slotMask
          (local.set $slot (i32.and (i32.add (local.get $slot) (i32.const 1)) (local.get $slotMask)))
          (br $probe)
        )
      )

      ;; if ($value !== 0) addValue($record, $value)
      (if (local.get $value)
        (then
          (call $addValue
            (local.get $record)
            (local.get $value)
            (local.get $weightsOfRecords)
            (local.get $countsOfRecords)
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
    (call $finishRecords
      (local.get $recordWeights)
      (local.get $recordCounts)
      (i32.sub (local.get $nextRecord) (local.get $firstRecord))
    )
  )

  (i32.sub (local.get $nextRecord) (local.get $firstRecord))
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
  (local $samplesOfRecords i32) ;; Starts of the vectors of records moved back by firstRecord elements.
  (local $classesOfRecords i32)
  (local $weightsOfRecords i32)
  (local $countsOfRecords i32)
  (local $sample i32)
  (local $class i32)
  (local $value i32)
  (local $previousSample i32)
  (local $runFirstRecord i32)
  (local $classAddr i32)
  (local $record i32)
  (local $nextRecord i32)
  (local $runCount i32)

  ;; for (let i = 0; i < size; i++) {
  ;;   if (the sample differs from the previous event's) a run starts with the next record
  ;;   record = classRecords[class], added when it's before the run
  ;;   if (value !== 0) {
  ;;     recordWeights[record] += value;
  ;;     recordCounts[record]++;
  ;;   }
  ;; }

  ;; $samplesOfRecords = $recordSamples - ($firstRecord << 2), and so on: a record numbered n is at n << 2 (n << 3)
  (local.set $samplesOfRecords (i32.sub (local.get $recordSamples) (i32.shl (local.get $firstRecord) (i32.const 2))))
  (local.set $classesOfRecords (i32.sub (local.get $recordClasses) (i32.shl (local.get $firstRecord) (i32.const 2))))
  (local.set $weightsOfRecords (i32.sub (local.get $recordWeights) (i32.shl (local.get $firstRecord) (i32.const 3))))
  (local.set $countsOfRecords (i32.sub (local.get $recordCounts) (i32.shl (local.get $firstRecord) (i32.const 2))))
  ;; $nextRecord = $firstRecord: the number of the next record added
  (local.set $nextRecord (local.get $firstRecord))
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
      ;; $runFirstRecord = $nextRecord, $previousSample = $sample, $runCount++
      (if (i32.ne (local.get $sample) (local.get $previousSample))
        (then
          (local.set $runFirstRecord (local.get $nextRecord))
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
          ;; $record = $nextRecord++
          (local.set $record (local.get $nextRecord))
          (local.set $nextRecord (i32.add (local.get $nextRecord) (i32.const 1)))
          (call $addRecord
            (local.get $record)
            (local.get $sample)
            (local.get $class)
            (local.get $samplesOfRecords)
            (local.get $classesOfRecords)
            (local.get $weightsOfRecords)
            (local.get $countsOfRecords)
          )
          ;; classRecords[$class] = $record
          (i32.store (local.get $classAddr) (local.get $record))
        )
      )

      ;; if ($value !== 0) addValue($record, $value)
      (if (local.get $value)
        (then
          (call $addValue
            (local.get $record)
            (local.get $value)
            (local.get $weightsOfRecords)
            (local.get $countsOfRecords)
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
    (call $finishRecords
      (local.get $recordWeights)
      (local.get $recordCounts)
      (i32.sub (local.get $nextRecord) (local.get $firstRecord))
    )
  )

  (i32.sub (local.get $nextRecord) (local.get $firstRecord))
)
