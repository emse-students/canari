## Reading owed - every route fits on REAL hardware

target: 1.7.0

**What is built:** every route fits on REAL hardware (the graphical pass of 2026-09-13 and the 2026-09-18 reports were read in Chrome with a device-metrics override only; [design-reference](../frontend/design-reference.md) sections 16-21 and 39)

**The reading that closes it:** `bun tools/cross-client-harness/sweep.mjs` (A1 = the Mi 9T, against dev): no route with `scrollWidth - clientWidth > 0` or an element past the viewport; the iPhone 12 by eye on the same routes (no CDP there)

**Triage 2026-11-14 - left: the Mi 9T `sweep.mjs` run against dev (about 10 min) and the iPhone 12 by eye on the twelve main routes with `ios.mjs` screenshots (about 25 min).** Shipped long ago; nothing here is unshipped.

**iPhone 12 half, READ 2026-11-15** (TestFlight `1.6.12-alpha.2`, dev, 390 x 844 points, French): twelve routes opened in the app and read by eye on a screenshot, plus the accessibility tree checked for any element past x = 391 or before x = 0: the feed (Organisations), chats, communities, the hub, Institutions, Boutique, Formulaires, Reservations, Jeux, the notifications list, a profile and the notification settings. No horizontal overflow, no clipped control, the tab bar clear of the content on each. Left: the Mi 9T `sweep.mjs` half.
