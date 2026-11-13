(import "imports" "memory" (memory 0))

;; Metrics of samples by an event pass over a population: PopulationFiltered computes them this way when they
;; can't come from records. Counts are u32 (4 bytes); totals summed from event values are f64 (8 bytes), exact
;; up to 2^53

;; Totals are f64 between passes and i64 during one: integerTotals converts them before the chunks of events of
;; a pass, floatTotals after them, since an integer add keeps the add-store-load chain of consecutive events of one
;; sample short

;; total[i] = BigInt(total[i]) for every sample
(func $integerTotals (export "integerTotals")
  (param $total i32)
  (param $totalSize i32)
  (local $index i32)
  (local $addr i32)

  (local.set $index (local.get $totalSize))
  (block $exit
    (loop $loop
      (br_if $exit (i32.eqz (local.get $index)))
      (local.set $index (i32.sub (local.get $index) (i32.const 1)))
      (local.set $addr (i32.add (local.get $total) (i32.shl (local.get $index) (i32.const 3))))
      (i64.store (local.get $addr) (i64.trunc_f64_u (f64.load (local.get $addr))))
      (br $loop)
    )
  )
)

;; total[i] = Number(total[i]) for every sample
(func $floatTotals (export "floatTotals")
  (param $total i32)
  (param $totalSize i32)
  (local $index i32)
  (local $addr i32)

  (local.set $index (local.get $totalSize))
  (block $exit
    (loop $loop
      (br_if $exit (i32.eqz (local.get $index)))
      (local.set $index (i32.sub (local.get $index) (i32.const 1)))
      (local.set $addr (i32.add (local.get $total) (i32.shl (local.get $index) (i32.const 3))))
      (f64.store (local.get $addr) (f64.convert_i64_u (i64.load (local.get $addr))))
      (br $loop)
    )
  )
)

;; A chunk of events adds to the integer totals of their samples
(func $accumulateSampleMetrics (export "accumulateSampleMetrics")
  (param $srcSize i32)
  (param $src i32)
  (param $map i32)
  (param $count i32)
  (param $total i32)
  (local $index i32) ;; Element index, iterated from the end.
  (local $value i32)
  (local $sample i32)
  (local $addr i32)

  ;; for (let i = srcSize - 1; i >= 0; i--) {
  ;;   if (src[i] !== 0) {
  ;;     count[map[i]] += 1;
  ;;     total[map[i]] += src[i];
  ;;   }
  ;; }

  (local.set $index (local.get $srcSize))

  (block $exit
    (loop $loop
      (br_if $exit (i32.eqz (local.get $index)))

      (local.set $index (i32.sub (local.get $index) (i32.const 1)))

      ;; if (src[i] === 0) continue;
      (br_if $loop
        (i32.eqz
          (local.tee $value
            (i32.load (i32.add (local.get $src) (i32.shl (local.get $index) (i32.const 2))))
          )
        )
      )

      (local.set $sample
        (i32.load (i32.add (local.get $map) (i32.shl (local.get $index) (i32.const 2))))
      )

      ;; count[map[i]] += 1 (u32)
      (local.set $addr (i32.add (local.get $count) (i32.shl (local.get $sample) (i32.const 2))))
      (i32.store
        (local.get $addr)
        (i32.add (i32.load (local.get $addr)) (i32.const 1))
      )

      ;; total[map[i]] += src[i] (i64)
      (local.set $addr (i32.add (local.get $total) (i32.shl (local.get $sample) (i32.const 3))))
      (i64.store
        (local.get $addr)
        (i64.add (i64.load (local.get $addr)) (i64.extend_i32_u (local.get $value)))
      )

      (br $loop)
    )
  )
)
