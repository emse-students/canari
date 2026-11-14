## Reading owed - a salon banner names its SPEAKER - a v2 author the phone names - with their face or initials, "Quelqu'un" and a "?"...

target: 1.7.0

**What is built:** a salon banner names its SPEAKER - a v2 author the phone names - with their face or initials, "Quelqu'un" and a "?" otherwise, never the salon's letter (Android #2881, iOS NSE and `canari_push.mm` 2026-11-01; JVM tests and text pins only, [mobile](../frontend/mobile.md#notification-service-extension-nse))

**The reading that closes it:** one salon banner on the Mi 9T and one on the iPhone 12 (app killed, then backgrounded), from a member the app has named and one it has not: the name above the line and their initials, then "Quelqu'un" with a "?" and the `[SALON_AUTHOR]` line in the log

**iPhone 12, a member the app has named, read 2026-11-14 on dev (`1.6.12-alpha.2`, app killed):** the same salon mention banner (title "nse banc communaute - #general", subtitle "Canari Test Delta vous a mentionne", delta's face as the attachment on the right) names the speaker, never the salon's letter. **Left: a member the app has NOT named ("Quelqu'un" with a "?" and the `[SALON_AUTHOR]` line), the backgrounded run, and the Mi 9T.**
