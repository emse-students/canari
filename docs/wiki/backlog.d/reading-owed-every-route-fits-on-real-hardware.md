## Reading owed - every route fits on REAL hardware

target: 1.7.0

**What is built:** every route fits on REAL hardware (the graphical pass of 2026-09-13 and the 2026-09-18 reports were read in Chrome with a device-metrics override only; [design-reference](../frontend/design-reference.md) sections 16-21 and 39)

**The reading that closes it:** `bun tools/cross-client-harness/sweep.mjs` (A1 = the Mi 9T, against dev): no route with `scrollWidth - clientWidth > 0` or an element past the viewport; the iPhone 12 by eye on the same routes (no CDP there)

**Triage 2026-11-14 - left: the Mi 9T `sweep.mjs` run against dev (about 10 min) and the iPhone 12 by eye on the twelve main routes with `ios.mjs` screenshots (about 25 min).** Shipped long ago; nothing here is unshipped.

**Mi 9T half, READ 2026-11-15 (`sweep.mjs --device A1`, dev, `1.6.12-alpha.2`, 436 CSS px at dpr 2.475):** 22 routes drawn, none with horizontal scroll, none clipped. Two flags, neither a defect: `/posts` reports two elements past the viewport (the blurred cover backdrops, `scale-125 blur-2xl inset-0`, -34..470 px, clipped by their own ancestor and never seen) and `/legal/privacy` three inner scrollers (its own scrolling blocks). Five routes redirect and were not drawn: `/` to the feed, `/events` to the calendar, `/documents` and `/admin` to the dashboard (the account is not staff), `/calendar/export`. **Left: the iPhone 12 by eye.**
