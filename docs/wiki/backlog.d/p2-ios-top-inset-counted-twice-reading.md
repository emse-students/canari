## P2 - the iPhone reading of the top inset's one owner

target: 1.7.1

**What shipped untested on a phone.** `CanariPublishSafeAreaInsets` now makes the WebView edge to
edge before it publishes the top inset, and nothing else does
([parity §1.1](../frontend/android-ios-parity.md#11-the-two-platforms-took-opposite-decisions-about-the-system-bars---fixed-2026-08-28)).
No workstation compiles `canari_ios.mm`. A bench build needs a local stack and replaces the dev
install, so the fix is read on the first `1.7.1` pre-release.

**The reading, on the iPhone 12:**

1. **A cold start.** In the syslog (`pymobiledevice3 syslog live -m Canari`), `WebView made edge to
   edge` comes BEFORE the first `safe area published to the page: ... top 47 pt`. No `ERROR the
   WebView's scroll view still insets its top` line appears.
2. **The header is right under the status bar.** Its row is centred around y = 75 pt, not 122 pt, and
   the strip above it is the header's surface colour.
3. **A launch that is not active at once.** The original state came from a launch under a system
   alert. A push or background launch, then an open from the icon, should show the same header as
   step 2.
4. **The pages with their own top padding** (a conversation, the camera, a full-screen modal) still
   clear the clock, and none of them doubles the inset.

Delete this file when the reading passes.
