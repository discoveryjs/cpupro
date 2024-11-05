(import "imports" "memory" (memory 0))

(func $accumulateSampleCount (export "accumulateSampleCount")
  (param $srcSize i32)
  (param $src i32)
  (param $map i32)
  (param $dest i32)
  (local $offset i32) ;; Byte offset for iteration through the arrays.
  (local $resultAddr i32) ;; Address in $dest array.

  ;; for (let i = srcSize - 1; i >= 0; i--) {
  ;;   dest[map[i]] += src[i];
  ;; }

  ;; Initialize $offset to the byte position of the last element
  (local.set $offset
    (i32.shl (local.get $srcSize) (i32.const 2))
  )

  (block $exit ;; Block for loop exit condition.
    (loop $loop ;; Start of loop.
      (br_if $exit
        (i32.eqz (local.get $offset))
      ) ;; Exit loop if offset === 0

      ;; Decrement 'offset' by 4 for the next iteration.
      ;; offset -= 4;
      (local.set $offset
        (i32.sub
          (local.get $offset)
          (i32.const 4)
        )
      )

      ;; Continue if value equals zero
      (br_if $loop
        (i32.eqz
          (i32.load
            (i32.add
              (local.get $src)
              (local.get $offset)
            )
          )
        )
      )

      ;; Calculate address in $dest array and store in $resultAddr.
      ;; resultAddr = dest + map[i] * 4  // dest[map[i]]
      (local.set $resultAddr
        (i32.add
          (local.get $dest)
          (i32.shl
            (i32.load
              (i32.add
                (local.get $map)
                (local.get $offset)
              )
            )
            (i32.const 2)
          )
        )
      )

      ;; Load the existing value at $resultAddr, add the time delta, then store the result back.
      ;; dest[$addr] += 1
      (i32.store
        (local.get $resultAddr)
        (i32.add
          (i32.load (local.get $resultAddr))
          (i32.const 1)
        )
      )

      (br $loop) ;; Repeat the loop.
    )
  )
)

(func $accumulateTimings (export "accumulateTimings")
  (param $srcSize i32)
  (param $src i32)
  (param $map i32)
  (param $dest i32)
  (local $offset i32) ;; Byte offset for iteration through the arrays.
  (local $value i32)
  (local $resultAddr i32) ;; Address in $dest array.

  ;; for (let i = srcSize - 1; i >= 0; i--) {
  ;;   dest[map[i]] += src[i];
  ;; }

  ;; Initialize $offset to the byte position of the last element
  (local.set $offset
    (i32.shl (local.get $srcSize) (i32.const 2))
  )

  (block $exit ;; Block for loop exit condition.
    (loop $loop ;; Start of loop.
      (br_if $exit
        (i32.eqz (local.get $offset))
      ) ;; Exit loop if offset === 0

      ;; Decrement 'offset' by 4 for the next iteration.
      ;; offset -= 4;
      (local.set $offset
        (i32.sub
          (local.get $offset)
          (i32.const 4)
        )
      )

      ;; Continue if value equals zero
      (br_if $loop
        (i32.eqz
          (local.tee $value
            (i32.load
              (i32.add
                (local.get $src)
                (local.get $offset)
              )
            )
          )
        )
      )

      ;; Calculate address in $dest array and store in $resultAddr.
      ;; resultAddr = dest + map[i] * 4  // dest[map[i]]
      (local.set $resultAddr
        (i32.add
          (local.get $dest)
          (i32.shl
            (i32.load
              (i32.add
                (local.get $map)
                (local.get $offset)
              )
            )
            (i32.const 2)
          )
        )
      )

      ;; Load the existing value at $resultAddr, add the time delta, then store the result back.
      ;; dest[$addr] += src[i]
      (i32.store
        (local.get $resultAddr)
        (i32.add
          (i32.load (local.get $resultAddr))
          (local.get $value)
        )
      )

      (br $loop) ;; Repeat the loop.
    )
  )
)

(func $rollupTreeTimings (export "rollupTreeTimings")
  (param $parent i32)
  (param $nodesCount i32)
  (param $selfTimes i32)
  (param $nestedTimes i32)
  (local $offset i32) ;; Byte offset for iteration through the arrays.
  (local $value i32)
  (local $resultAddr i32) ;; Address in $samplesTimes array.

  ;; for (let i = nodesCount - 1; i > 0; i--) {
  ;;   nestedTimes[parent[i]] += selfTimes[i] + nestedTimes[i];
  ;; }

  ;; Initialize $offset to the byte position of the last element
  (local.set $offset
    (i32.shl (local.get $nodesCount) (i32.const 2))
  )
  (block $exit ;; Block for loop exit condition.
    (loop $loop ;; Start of loop.
      (br_if $exit
        (i32.le_s (local.get $offset) (i32.const 4))
      ) ;; Exit loop if offset === 0

      ;; Decrement 'offset' by 4 for the next iteration.
      (local.set $offset
        (i32.sub
          (local.get $offset)
          (i32.const 4)
        )
      )

      ;; Continue if value equals zero
      (br_if $loop
        (i32.eqz
          (local.tee $value
            (i32.add
              (i32.load
                (i32.add
                  (local.get $selfTimes)
                  (local.get $offset)
                )
              )
              (i32.load
                (i32.add
                  (local.get $nestedTimes)
                  (local.get $offset)
                )
              )
            )
          )
        )
      )

      ;; Calculate address in $nestedTimes array and store in $resultAddr.
      (local.set $resultAddr
        (i32.add
          (local.get $nestedTimes)
          (i32.shl
            (i32.load
              (i32.add
                (local.get $parent)
                (local.get $offset)
              )
            )
            (i32.const 2)
          )
        )
      )

      ;; Load the existing value at $resultAddr, add the self time and nested time, then store the result back
      (i32.store
        (local.get $resultAddr)
        (i32.add
          (i32.load (local.get $resultAddr))
          (local.get $value)
        )
      )

      (br $loop) ;; Repeat the loop.
    )
  )
)

(func $rollupDictionaryTimings (export "rollupDictionaryTimings")
  (param $totalNodesSize i32)
  (param $totalNodes i32)
  (param $nodeSelfTimes i32)
  (param $nodeNestedTimes i32)
  (param $totalNodeToDict i32)
  (param $totalTimes i32)
  (local $offset i32) ;; Byte offset for iteration through the arrays.
  (local $nodeId i32)
  (local $value i32)
  (local $resultAddr i32) ;; Address in $samplesTimes array.

  ;; for (let i = nodesCount - 1; i >= 0; i--) {
  ;;     const nodeId = totalNodes[i];
  ;;     const selfTime = nodeSelfTimes[nodeId];
  ;;     const nestedTime = nodeNestedTimes[nodeId];
  ;;     totalTimes[totalNodeToDict[i]] += selfTime + nestedTime;
  ;; }

  ;; Initialize $offset to the byte position of the last element
  (local.set $offset
    (i32.shl (local.get $totalNodesSize) (i32.const 2))
  )
  (block $exit ;; Block for loop exit condition.
    (loop $loop ;; Start of loop.
      (br_if $exit
        (i32.eqz (local.get $offset))
      ) ;; Exit loop if offset === 0

      ;; Decrement 'offset' by 4 for the next iteration.
      ;; $offset = $offset - 4
      (local.set $offset
        (i32.sub
          (local.get $offset)
          (i32.const 4)
        )
      )

      ;; $nodeId = i32.load($totalNodes + $offset) << 2
      ;; \-> nodeId = totalNodes[offset] * 4
      (local.set $nodeId
        (i32.shl
          (i32.load
            (i32.add
              (local.get $totalNodes)
              (local.get $offset)
            )
          )
          (i32.const 2)
        )
      )

      ;; Continue if value equals zero
      (br_if $loop
        (i32.eqz
          ;; $value = i32.load($nodeSelfTimes + $nodeId) + i32.load($nodeNestedTimes + $nodeId)
          ;; \-> value = nodeSelfTimes[nodeId] + nodeNestedTimes[nodeId]
          (local.tee $value
            (i32.add
              (i32.load
                (i32.add
                  (local.get $nodeSelfTimes)
                  (local.get $nodeId)
                )
              )
              (i32.load
                (i32.add
                  (local.get $nodeNestedTimes)
                  (local.get $nodeId)
                )
              )
            )
          )
        )
      )

      ;; Calculate address in $totalTimes array and store in $resultAddr.
      ;; $resultAddr = $totalTimes + i32.load($totalNodeToDict + $offset) << 2
      ;; \-> resultAddr = totalTimes[totalNodeDict[offset] * 4]
      (local.set $resultAddr
        (i32.add
          (local.get $totalTimes)
          (i32.shl
            (i32.load
              (i32.add
                (local.get $totalNodeToDict)
                (local.get $offset)
              )
            )
            (i32.const 2)
          )
        )
      )

      ;; Load the existing value at $resultAddr, add the self time and nested time, then store the result back
      (i32.store
        (local.get $resultAddr)
        (i32.add
          (i32.load (local.get $resultAddr))
          (local.get $value)
        )
      )

      (br $loop) ;; Repeat the loop.
    )
  )
)
