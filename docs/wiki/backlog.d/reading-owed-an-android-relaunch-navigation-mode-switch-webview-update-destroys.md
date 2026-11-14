## Reading owed - an Android relaunch (navigation-mode switch, WebView update) destroys the old WebView, so its Web Locks no longer...

target: 1.7.0

**What is built:** an Android relaunch (navigation-mode switch, WebView update) destroys the old WebView, so its Web Locks no longer withhold refused salon texts (2026-10-14; compiled and source-gated, never run)

**The reading that closes it:** on the Mi 9T, next pre-release: switch the navigation mode twice, CDP lists ONE page, a salon text refused before the switch comes back to its composer; restore gestural ([mobile](../frontend/mobile.md#a-relaunched-activity-left-its-webview-alive-and-the-orphan-kept-its-web-locks-2026-10-14))

**Half read on the Mi 9T 2026-11-14 (`1.6.12`):** the navigation mode switched to 3-button and back to gestural (`cmd overlay enable-exclusive`): each switch relaunches the window in the SAME process (`finishDrawing of relaunch`) and CDP lists ONE page after each. **Left: the refused salon text** that must come back to its composer after the switch (needs a refusal staged before the switch).
