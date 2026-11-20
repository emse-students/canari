## P2 - the reply swipe along a thumb's arc does nothing on WebKit: the thread scrolls instead

target: 1.7.3

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-18, sitting [S7](../device-verification.md#the-web-and-phone-readings-of-2026-11-18-s7-170-alpha12-the-last-sitting-before-the-stable): **closes WITH the `1.7.0` stable and does NOT block cutting it** - the fix (#3605) was read on the iPhone on `1.7.0-alpha.1`; this file is deleted the day the stable ships._

_2026-11-17, scope cut: KEPT in `1.7.0` - its fix (#3605) is in `1.7.0` and was read; the entry closes with that stable ([decisions](owner-decisions-of-2026-11-17.md))._

Read on the iPhone 12 on 2026-11-15 (`v1.6.12` dev build, a WDA W3C touch sequence of 12 moves, a received bubble in a DM, thread at its bottom): a 110 px stroke to the right with 45 px of vertical drift, down and up, and with 60 px, down and up, replied **0 times in 5** and the thread scrolled by about 35 px each time; the same stroke with 0 px and with 20 px of drift staged exactly one reply, 30 px did not. A 110 px stroke to the left and a 40 px stroke to the right staged nothing, a 60 px stroke to the right staged one (the trigger is 56 px). The Android fix of 2026-10-14 ([design-reference](../frontend/design-reference.md#the-reply-swipe-that-sometimes-did-nothing-two-classes-measured-mi-9t-2026-10-14)) lets a locked horizontal stroke ignore the vertical axis, but on WebKit the page never gets the stroke: the bubble sets no `touch-action`, so WKWebView probably claims a stroke with this much drift as a vertical pan before the page's 10 px lock, and the page sees a cancel (the mechanism is an inference, not measured).

What closes it: a `touch-action` on the bubble that leaves the horizontal axis to the page (to be measured: `pan-y` first), the same five arcs re-read on the iPhone 12, and a regression test of the style. Evidence: the harness state folder `readings-iphone-1115c/` (screenshots `r1-*.png`).

**Fix read on the iPhone 12, 2026-11-15, `1.7.0-alpha.1` (#3605): 6 of 6 arcs of 110 pt with 45, -45, 60, -60, 45 and -45 pt of drift, on a received bubble, each staged one reply** (the same cell staged 0 of 5 on `1.6.12`). Closes at the stable that carries it (the reading entry was closed 2026-11-16: both phones read `PASS`).
