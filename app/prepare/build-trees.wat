(import "imports" "memory" (memory 0))

(func $makeFirstNextArrays (export "makeFirstNextArrays")
  (param $parent i32)
  (param $subtreeSize i32)
  (param $firstChild i32)
  (param $nextSibling i32)
  (param $length i32)

  (local $i i32)
  (local $size i32)
  (local $nextSiblingCandidate i32)

  (block $exit
    (loop $loop
      ;; Check if loop should exit (if i >= length)
      (br_if $exit
        (i32.ge_s 
          (local.get $i) 
          (local.get $length)
        )
      )
      ;; size = subtreeSize[i]
      (local.set $size 
        (i32.load 
          (i32.add 
            (local.get $subtreeSize) 
            (i32.shl (local.get $i) (i32.const 2))
          )
        )
      )
      ;; Check if size > 0 (has children)
      (if 
        (i32.gt_s 
          (local.get $size) 
          (i32.const 0)
        )
        (then
          ;; firstChild[i] = i + 1
          (i32.store 
            (i32.add 
              (local.get $firstChild) 
              (i32.shl (local.get $i) (i32.const 2))
            ) 
            (i32.add (local.get $i) (i32.const 1))
          )
        )
      )
      ;; nextSiblingCandidate = i + size + 1
      (local.set $nextSiblingCandidate 
        (i32.add 
          (local.get $i) 
          (i32.add 
            (local.get $size) 
            (i32.const 1)
          )
        )
      )
      ;; Check if next has the same parent
      ;; parent[i] === parent[nextSiblingCandidate]
      (if 
        (i32.eq 
          (i32.load 
            (i32.add 
              (local.get $parent) 
              (i32.shl (local.get $i) (i32.const 2))
            )
          ) 
          (i32.load 
            (i32.add 
              (local.get $parent) 
              (i32.shl (local.get $nextSiblingCandidate) (i32.const 2))
            )
          )
        )
        (then
          ;; nextSibling[i] = nextSiblingCandidate
          (i32.store 
            (i32.add 
              (local.get $nextSibling) 
              (i32.shl (local.get $i) (i32.const 2))
            ) 
            (local.get $nextSiblingCandidate)
          )
        )
      )
      ;; Increment i
      (local.set $i 
        (i32.add 
          (local.get $i) 
          (i32.const 1)
        )
      )
      ;; Loop back
      (br $loop)
    ) ;; End of $loop
  ) ;; End of block $exit
) ;; End of $makeFirstNextArrays
