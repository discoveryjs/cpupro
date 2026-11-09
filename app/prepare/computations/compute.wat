(import "imports" "memory" (memory 0))

;; Counts and indices are u32 (4 bytes); values summed from event values are f64 (8 bytes), exact up to 2^53

;; Totals are f64; they are converted to i64 for the event pass and back, since an integer add keeps
;; the add-store-load chain of consecutive events of one sample short
(func $accumulateSampleMetrics (export "accumulateSampleMetrics")
  (param $srcSize i32)
  (param $src i32)
  (param $map i32)
  (param $count i32)
  (param $total i32)
  (param $totalSize i32)
  (local $index i32) ;; Element index, iterated from the end.
  (local $value i32)
  (local $sample i32)
  (local $addr i32)

  ;; total[i] = BigInt(total[i]) for every sample
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

  ;; total[i] = Number(total[i]) for every sample
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

(func $accumulateCounts (export "accumulateCounts")
  (param $srcSize i32)
  (param $src i32)
  (param $map i32)
  (param $dest i32)
  (local $index i32)
  (local $value i32)
  (local $resultAddr i32)

  ;; for (let i = srcSize - 1; i >= 0; i--) {
  ;;   dest[map[i]] += src[i]; (u32)
  ;; }

  (local.set $index (local.get $srcSize))

  (block $exit
    (loop $loop
      (br_if $exit (i32.eqz (local.get $index)))

      (local.set $index (i32.sub (local.get $index) (i32.const 1)))

      (br_if $loop
        (i32.eqz
          (local.tee $value
            (i32.load (i32.add (local.get $src) (i32.shl (local.get $index) (i32.const 2))))
          )
        )
      )

      (local.set $resultAddr
        (i32.add
          (local.get $dest)
          (i32.shl
            (i32.load (i32.add (local.get $map) (i32.shl (local.get $index) (i32.const 2))))
            (i32.const 2)
          )
        )
      )

      (i32.store
        (local.get $resultAddr)
        (i32.add (i32.load (local.get $resultAddr)) (local.get $value))
      )

      (br $loop)
    )
  )
)

(func $accumulateValues (export "accumulateValues")
  (param $srcSize i32)
  (param $src i32)
  (param $map i32)
  (param $dest i32)
  (local $index i32)
  (local $value f64)
  (local $resultAddr i32)

  ;; for (let i = srcSize - 1; i >= 0; i--) {
  ;;   dest[map[i]] += src[i]; (f64)
  ;; }

  (local.set $index (local.get $srcSize))

  (block $exit
    (loop $loop
      (br_if $exit (i32.eqz (local.get $index)))

      (local.set $index (i32.sub (local.get $index) (i32.const 1)))

      (br_if $loop
        (f64.eq
          (local.tee $value
            (f64.load (i32.add (local.get $src) (i32.shl (local.get $index) (i32.const 3))))
          )
          (f64.const 0)
        )
      )

      (local.set $resultAddr
        (i32.add
          (local.get $dest)
          (i32.shl
            (i32.load (i32.add (local.get $map) (i32.shl (local.get $index) (i32.const 2))))
            (i32.const 3)
          )
        )
      )

      (f64.store
        (local.get $resultAddr)
        (f64.add (f64.load (local.get $resultAddr)) (local.get $value))
      )

      (br $loop)
    )
  )
)

(func $rollupTreeMetrics (export "rollupTreeMetrics")
  (param $parent i32)
  (param $nodesCount i32)
  (param $selfValues i32)
  (param $nestedValues i32)
  (local $index i32)
  (local $value f64)
  (local $resultAddr i32)

  ;; for (let i = nodesCount - 1; i > 0; i--) {
  ;;   nestedValues[parent[i]] += selfValues[i] + nestedValues[i];
  ;; }

  (local.set $index (local.get $nodesCount))

  (block $exit
    (loop $loop
      (br_if $exit (i32.le_s (local.get $index) (i32.const 1)))

      (local.set $index (i32.sub (local.get $index) (i32.const 1)))

      (br_if $loop
        (f64.eq
          (local.tee $value
            (f64.add
              (f64.load (i32.add (local.get $selfValues) (i32.shl (local.get $index) (i32.const 3))))
              (f64.load (i32.add (local.get $nestedValues) (i32.shl (local.get $index) (i32.const 3))))
            )
          )
          (f64.const 0)
        )
      )

      (local.set $resultAddr
        (i32.add
          (local.get $nestedValues)
          (i32.shl
            (i32.load (i32.add (local.get $parent) (i32.shl (local.get $index) (i32.const 2))))
            (i32.const 3)
          )
        )
      )

      (f64.store
        (local.get $resultAddr)
        (f64.add (f64.load (local.get $resultAddr)) (local.get $value))
      )

      (br $loop)
    )
  )
)

(func $rollupDictionaryMetrics (export "rollupDictionaryMetrics")
  (param $totalNodesSize i32)
  (param $totalNodes i32)
  (param $nodeSelfValues i32)
  (param $nodeNestedValues i32)
  (param $totalNodeToDict i32)
  (param $totalValues i32)
  (local $index i32)
  (local $nodeOffset i32)
  (local $value f64)
  (local $resultAddr i32)

  ;; for (let i = totalNodesSize - 1; i >= 0; i--) {
  ;;     const nodeId = totalNodes[i];
  ;;     totalValues[totalNodeToDict[i]] += nodeSelfValues[nodeId] + nodeNestedValues[nodeId];
  ;; }

  (local.set $index (local.get $totalNodesSize))

  (block $exit
    (loop $loop
      (br_if $exit (i32.eqz (local.get $index)))

      (local.set $index (i32.sub (local.get $index) (i32.const 1)))

      ;; nodeOffset = totalNodes[i] * 8
      (local.set $nodeOffset
        (i32.shl
          (i32.load (i32.add (local.get $totalNodes) (i32.shl (local.get $index) (i32.const 2))))
          (i32.const 3)
        )
      )

      (br_if $loop
        (f64.eq
          (local.tee $value
            (f64.add
              (f64.load (i32.add (local.get $nodeSelfValues) (local.get $nodeOffset)))
              (f64.load (i32.add (local.get $nodeNestedValues) (local.get $nodeOffset)))
            )
          )
          (f64.const 0)
        )
      )

      (local.set $resultAddr
        (i32.add
          (local.get $totalValues)
          (i32.shl
            (i32.load (i32.add (local.get $totalNodeToDict) (i32.shl (local.get $index) (i32.const 2))))
            (i32.const 3)
          )
        )
      )

      (f64.store
        (local.get $resultAddr)
        (f64.add (f64.load (local.get $resultAddr)) (local.get $value))
      )

      (br $loop)
    )
  )
)
