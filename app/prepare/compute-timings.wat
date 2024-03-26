(import "imports" "memory" (memory 0))

(func $accumulateTimings (export "accumulateTimings")
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
          (i32.load 
            (local.get $resultAddr)
          )
          (i32.load 
            (i32.add 
              (local.get $src) 
              (local.get $offset)
            )
          )
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
          (i32.load
            (local.get $resultAddr)
          )
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
  (local $nodeId i32) ;; Byte offset for iteration through the arrays.
  (local $resultAddr i32) ;; Address in $samplesTimes array.

  ;; for (let i = nodesCount - 1; i > 0; i--) {
  ;;   nestedTimes[parent[i]] += selfTimes[i] + nestedTimes[i];
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
      (local.set $offset
        (i32.sub
          (local.get $offset)
          (i32.const 4)
        )
      )

      ;; Calculate address in $totalTimes array and store in $resultAddr.
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

      ;; Load the existing value at $resultAddr, add the self time and nested time, then store the result back
      (i32.store
        (local.get $resultAddr)
        (i32.add
          (i32.load
            (local.get $resultAddr)
          )
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

      (br $loop) ;; Repeat the loop.
    )
  )
)
