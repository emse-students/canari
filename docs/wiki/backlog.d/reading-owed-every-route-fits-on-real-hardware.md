## Reading owed - every route fits on REAL hardware

target: 1.7.0

**What is built:** every route fits on REAL hardware (the graphical pass of 2026-09-13 and the 2026-09-18 reports were read in Chrome with a device-metrics override only; [design-reference](../frontend/design-reference.md) sections 16-21 and 39)

**The reading that closes it:** `bun tools/cross-client-harness/sweep.mjs` (A1 = the Mi 9T, against dev): no route with `scrollWidth - clientWidth > 0` or an element past the viewport; the iPhone 12 by eye on the same routes (no CDP there)
