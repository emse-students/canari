## Reading owed - a reply swipe along a thumb's arc

target: 1.7.0

**What is built:** a reply swipe along a thumb's arc (45-70 px of vertical drift) replies once the bubble shows armed (2026-10-14; 0 of 14 before, unit and component tests since)

**The reading that closes it:** on the Mi 9T, next pre-release: the class-A cells of the matrix (`<harness-dir>/swipe-reply-r1014/`), 110 px across with 45 and 60 px drift, own and received ([design-reference](../frontend/design-reference.md#the-reply-swipe-that-sometimes-did-nothing-two-classes-measured-mi-9t-2026-10-14))

**Triage 2026-11-14: Mi 9T class-A cells about 15 min (`adb input swipe`, stated as not a finger), iPhone 12 the same arc driven through WDA about 15 min.**

**Mi 9T class-A cells, READ 2026-11-15 (`1.6.12-alpha.2`, `adb input touchscreen swipe`, stated as not a finger):** 110 px across in 250 ms with 45 and 60 px of vertical drift, an own bubble and a received one, keyboard closed, three runs per cell: 12 of 12 raised the reply bar (maxDrag 72 each time). The rig's old bar selector (`.bg-amber-500.w-1.5`) no longer matches the page, so a first pass read "no bar" 12 times; the bar was on screen ("Répondre à ...") and the selector was patched in the rig's copy. **** Build note: read on `v1.6.12-alpha.2` (built for dev, tag on `fa1bc2655`), not the stable APK; `v1.6.12` is the bump commit `0b6947d20` directly over it (version files and changelog fragments only), so the code read is the stable's.

**iPhone 12 half, READ for an own bubble 2026-11-15** (TestFlight `1.6.12-alpha.2`, dev; WDA W3C touch sequence of 8 moves, an arc, not an `adb` swipe): on an own bubble, a swipe to the left of 110 px with 45 px and with 60 px of vertical drift each staged exactly one reply ("Repondre a ..." with its cancel); a swipe of 110 px to the right and a short one of 60 px across did not. The swipe had never been read on WebKit before. Left on the iPhone: a RECEIVED bubble (the bench DM holds none; it needs a message from another account).

**Left in this entry (both halves merged 2026-11-15): the iPhone 12 arc on a RECEIVED bubble only.**

**The iPhone 12 half was read 2026-11-15 and FAILED** (a W3C touch arc through WDA, `v1.6.12` dev build, received bubbles): 0 replies of 5 arcs of 110 px with 45 and 60 px of drift, down and up, the thread scrolling instead; the same stroke with 0 and 20 px of drift replied, 30 px did not. Its own defect: [p2-the-reply-swipe-along-a-thumb-s-arc-does-nothing-on-webkit.md](p2-the-reply-swipe-along-a-thumb-s-arc-does-nothing-on-webkit.md).

**The iPhone 12 RECEIVED-bubble cell, RE-READ 2026-11-15 on `1.7.0-alpha.1` (carries #3605): `PASS`, 6 of 6.** A W3C touch sequence of ten moves on a received text bubble, 110 pt to the right with 45, -45, 60, -60, 45 and -45 pt of vertical drift: each staged exactly one "Repondre a ..." bar (0 of 5 on `1.6.12`); a straight stroke did too. With the Mi 9T's 12 of 12 this closes the reading on both phones; the entry and [the WebKit defect](p2-the-reply-swipe-along-a-thumb-s-arc-does-nothing-on-webkit.md) are ready to go at the stable that carries #3605. Detail: [device-verification](../device-verification.md#the-iphone-12-readings-of-2026-11-15-170-alpha1-first-sitting-on-it).
