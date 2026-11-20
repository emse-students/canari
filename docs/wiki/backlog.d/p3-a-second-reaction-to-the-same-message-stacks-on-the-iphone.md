## P3 - a second reaction to the same message stacks on the iPhone, where Android replaces it

target: 1.7.2

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

**Seen 2026-11-18 (iPhone 12, `1.7.0-alpha.11`, dev, [readings](../device-verification.md#the-phone-readings-of-2026-11-18-m1-and-i1-170-alpha11)):** `beta` reacted ❤️ then 😂 to one message of `gamma`'s, locked and then killed: two entries in Notification Center each time; the Mi 9T replaced the first.

**Built for `1.7.1`, the recommended option (reversible):** the iOS identifier is one per (message, reactor), the instant dropped from `reactionCollapseId` on both sides (the shared vector moved in both suites), the page's post still throttled per reaction; the content-free review of the id is re-done in [content-free-push](../protocols/content-free-push.md), the mechanism and the `1.7.0` skew in [mobile](../frontend/mobile.md#the-frame-trigger-of-a-reaction-2026-11-17).

**The reading owed (read on the next `1.7.1` pre-release, the iPhone 12, server and app both `1.7.1`):** `beta` reacts ❤️ then 😂 to one of `gamma`'s messages, the iPhone locked, then with the app killed: ONE entry each time, reading the 😂 (with the app in front, the slot may read the ❤️ if APNs delivers its push last - stale, not a FAIL; two entries are). A reaction from another seat to the same message keeps its own entry. Charter: principle 3 (your attention is not for sale).
