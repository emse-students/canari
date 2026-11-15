## P3 - a 13 MB upload on the iPhone restarted at about half and ran at 40 to 65 KB/s

target: 1.7.0

**Seen 2026-11-15 (iPhone 12, `1.7.0-alpha.1`, dev, [readings](../device-verification.md#the-iphone-12-readings-of-2026-11-15-170-alpha1-third-sitting)):** a 13 631 488-byte file queued offline, the app killed and relaunched, then sent. The bubble's progress went from 2 % to 50 %, then read 6 % and climbed again to the sent state: one attempt was restarted at about half. The whole send took about 5 minutes (roughly 40 to 65 KB/s) on a Wi-Fi where the same phone downloaded the same file from the workstation in seconds. The file arrived complete.

**Not known:** whether the restart is the transport's idle guard ([offline-and-weak-network 13.4](../frontend/offline-and-weak-network.md#134-wp-off-8-built-a-bubble-that-says-how-much-has-gone-and-can-be-ended)), a chunked-upload retry, or the app's relaunch path re-enqueuing the entry while the first attempt was still running; and whether the rate is the bench uplink or the app. The store build has no console, so the phone could not say. **To do:** read the dev server's upload request log for that minute (one `complete` or two), repeat the send on the Mi 9T after a kill to see whether the restart is iOS-only, and measure the same file sent without a kill.
