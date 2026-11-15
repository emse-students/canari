## Reading owed - a reply swipe along a thumb's arc

target: 1.7.0

**What is built:** a reply swipe along a thumb's arc (45-70 px of vertical drift) replies once the bubble shows armed (2026-10-14; 0 of 14 before, unit and component tests since)

**The reading that closes it:** on the Mi 9T, next pre-release: the class-A cells of the matrix (`<harness-dir>/swipe-reply-r1014/`), 110 px across with 45 and 60 px drift, own and received; on the iPhone 12, the same arc by finger, its swipe never having been read on WebKit ([design-reference](../frontend/design-reference.md#the-reply-swipe-that-sometimes-did-nothing-two-classes-measured-mi-9t-2026-10-14))

**Triage 2026-11-14: Mi 9T class-A cells about 15 min (`adb input swipe`, stated as not a finger), iPhone 12 the same arc driven through WDA about 15 min.**

**Mi 9T class-A cells, READ 2026-11-15 (`1.6.12-alpha.2`, `adb input touchscreen swipe`, stated as not a finger):** 110 px across in 250 ms with 45 and 60 px of vertical drift, an own bubble and a received one, keyboard closed, three runs per cell: 12 of 12 raised the reply bar (maxDrag 72 each time). The rig's old bar selector (`.bg-amber-500.w-1.5`) no longer matches the page, so a first pass read "no bar" 12 times; the bar was on screen ("Répondre à ...") and the selector was patched in the rig's copy. **** Build note: read on `v1.6.12-alpha.2` (built for dev, tag on `fa1bc2655`), not the stable APK; `v1.6.12` is the bump commit `0b6947d20` directly over it (version files and changelog fragments only), so the code read is the stable's.

**iPhone 12 half, READ for an own bubble 2026-11-15** (TestFlight `1.6.12-alpha.2`, dev; WDA W3C touch sequence of 8 moves, an arc, not an `adb` swipe): on an own bubble, a swipe to the left of 110 px with 45 px and with 60 px of vertical drift each staged exactly one reply ("Repondre a ..." with its cancel); a swipe of 110 px to the right and a short one of 60 px across did not. The swipe had never been read on WebKit before. Left on the iPhone: a RECEIVED bubble (the bench DM holds none; it needs a message from another account).

**Left in this entry (both halves merged 2026-11-15): the iPhone 12 arc on a RECEIVED bubble only.**
