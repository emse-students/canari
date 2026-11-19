## P2 - the iPhone reading of the top inset's one owner

target: 1.7.1

_2026-11-19, sitting [S9](../device-verification.md#the-phone-readings-of-2026-11-19-s9-171-alpha3) on `1.7.1-alpha.3`: **steps 1, 2 and 4 PASSED; step 3 is owed.** Step 1: `WebView made edge to edge: ... (top now 0 pt), offset 0.0 -> 0.0` one millisecond before `safe area published to the page: bottom 0 pt, top 47 pt`, no ERROR line. Step 2: the header row centred near 75 pt, the strip above it the header's surface. Step 4: a conversation, the in-app camera and the new-post dialog each clear the clock, none doubled. Step 3 (a launch not active at once) needs a push or background launch and was not taken._

**What shipped untested on a phone.** `CanariPublishSafeAreaInsets` now makes the WebView edge to
edge before it publishes the top inset, and nothing else does
([parity, section 1.1](../frontend/android-ios-parity.md#11-the-two-platforms-took-opposite-decisions-about-the-system-bars---fixed-2026-08-28)).
No workstation compiles `canari_ios.mm`. A bench build needs a local stack and replaces the dev
install, so the fix is read on the first `1.7.1` pre-release.

**The reading, on the iPhone 12:**

1. **A cold start.** In the syslog (`pymobiledevice3 syslog live -m Canari`), `WebView made edge to
   edge` comes BEFORE the first `safe area published to the page: ... top 47 pt`. No `ERROR the
   WebView's scroll view still insets its top` line appears. The edge-to-edge line's `offset A -> B`
   records which mechanism was live: `-47.0 -> 0.0` means UIKit had already set the offset that
   used to strand.
2. **The header is right under the status bar.** Its row is centred around y = 75 pt, not 122 pt, and
   the strip above it is the header's surface colour.
3. **A launch that is not active at once.** The original state came from a launch under a system
   alert. A push or background launch, then an open from the icon, should show the same header as
   step 2.
4. **The pages with their own top padding** (a conversation, the camera, a full-screen modal) still
   clear the clock, and none of them doubles the inset.

Delete this file when the reading passes.
