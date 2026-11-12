(import "imports" "memory" (memory 0))

;; Sites of elements: a site is an (owner, offset, context) key in a hash table with linear probing, numbered
;; in the order of addition; the table holds the site of each key at slots, the keys of sites at siteOwners,
;; siteOffsets and siteContexts. Returns the site count with the sites added for the elements
(func $findSites (export "findSites")
  (param $size i32)
  (param $owners i32)
  (param $offsets i32)
  (param $contexts i32)
  (param $sites i32)
  (param $slots i32)
  (param $slotMask i32)
  (param $siteOwners i32)
  (param $siteOffsets i32)
  (param $siteContexts i32)
  (param $count i32)
  (result i32)
  (local $index i32)
  (local $addr i32)
  (local $siteAddr i32)
  (local $owner i32)
  (local $offset i32)
  (local $context i32)
  (local $site i32)
  (local $hash i32)
  (local $homeSlot i32)
  (local $slot i32)

  ;; for (let i = 0; i < size; i++) {
  ;;   if (i === 0 || the key of the element differs from the previous one) {
  ;;     site = the site of the key, added when missing
  ;;   }
  ;;   sites[i] = site;
  ;; }

  (block $exit
    (loop $loop
      (br_if $exit (i32.eq (local.get $index) (local.get $size)))

      (local.set $addr (i32.shl (local.get $index) (i32.const 2)))

      ;; an element of the previous key takes its site without a lookup
      (if
        (i32.or
          (i32.eqz (local.get $index))
          (i32.or
            (i32.ne (i32.load (i32.add (local.get $offsets) (local.get $addr))) (local.get $offset))
            (i32.or
              (i32.ne (i32.load (i32.add (local.get $contexts) (local.get $addr))) (local.get $context))
              (i32.ne (i32.load (i32.add (local.get $owners) (local.get $addr))) (local.get $owner))
            )
          )
        )
        (then
          (local.set $owner (i32.load (i32.add (local.get $owners) (local.get $addr))))
          (local.set $offset (i32.load (i32.add (local.get $offsets) (local.get $addr))))
          (local.set $context (i32.load (i32.add (local.get $contexts) (local.get $addr))))

          ;; hash = owner ^ imul(offset, 0x85ebca6b) ^ imul(context, 0xc2b2ae35), mixed by imul(hash, 0x9e3779b1)
          (local.set $hash
            (i32.mul
              (i32.xor
                (local.get $owner)
                (i32.xor
                  (i32.mul (local.get $offset) (i32.const 0x85ebca6b))
                  (i32.mul (local.get $context) (i32.const 0xc2b2ae35))
                )
              )
              (i32.const 0x9e3779b1)
            )
          )
          (local.set $homeSlot
            (i32.and
              (i32.xor (local.get $hash) (i32.shr_u (local.get $hash) (i32.const 16)))
              (local.get $slotMask)
            )
          )
          (local.set $slot (local.get $homeSlot))
          (local.set $site (i32.load (i32.add (local.get $slots) (i32.shl (local.get $slot) (i32.const 2)))))

          (block $found
            (block $missing
              (loop $probe
                (br_if $missing (i32.eq (local.get $site) (i32.const -1)))

                (local.set $siteAddr (i32.shl (local.get $site) (i32.const 2)))

                (if
                  (i32.and
                    (i32.eq (i32.load (i32.add (local.get $siteOffsets) (local.get $siteAddr))) (local.get $offset))
                    (i32.and
                      (i32.eq (i32.load (i32.add (local.get $siteContexts) (local.get $siteAddr))) (local.get $context))
                      (i32.eq (i32.load (i32.add (local.get $siteOwners) (local.get $siteAddr))) (local.get $owner))
                    )
                  )
                  (then
                    ;; a found site takes its home slot, the displaced site takes the found one's slot
                    ;; that follows the home slot in the same run of occupied slots
                    (if (i32.ne (local.get $slot) (local.get $homeSlot))
                      (then
                        (i32.store
                          (i32.add (local.get $slots) (i32.shl (local.get $slot) (i32.const 2)))
                          (i32.load (i32.add (local.get $slots) (i32.shl (local.get $homeSlot) (i32.const 2))))
                        )
                        (i32.store
                          (i32.add (local.get $slots) (i32.shl (local.get $homeSlot) (i32.const 2)))
                          (local.get $site)
                        )
                      )
                    )
                    (br $found)
                  )
                )

                (local.set $slot (i32.and (i32.add (local.get $slot) (i32.const 1)) (local.get $slotMask)))
                (local.set $site (i32.load (i32.add (local.get $slots) (i32.shl (local.get $slot) (i32.const 2)))))
                (br $probe)
              )
            )

            ;; a missing site is added as the next one at the empty slot
            (local.set $site (local.get $count))
            (local.set $count (i32.add (local.get $count) (i32.const 1)))
            (local.set $siteAddr (i32.shl (local.get $site) (i32.const 2)))
            (i32.store (i32.add (local.get $siteOwners) (local.get $siteAddr)) (local.get $owner))
            (i32.store (i32.add (local.get $siteOffsets) (local.get $siteAddr)) (local.get $offset))
            (i32.store (i32.add (local.get $siteContexts) (local.get $siteAddr)) (local.get $context))
            (i32.store (i32.add (local.get $slots) (i32.shl (local.get $slot) (i32.const 2))) (local.get $site))
          )
        )
      )

      (i32.store (i32.add (local.get $sites) (local.get $addr)) (local.get $site))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $loop)
    )
  )

  (local.get $count)
)
