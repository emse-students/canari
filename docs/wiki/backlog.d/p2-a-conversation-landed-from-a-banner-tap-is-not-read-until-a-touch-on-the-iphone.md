## P2 - on the iPhone a conversation landed from a banner tap was not read until a touch (2026-11-26; fix built, reading owed)

target: 1.8.3

Found on the iPhone 12, `1.8.2`, 2026-11-26 ([sitting](../device-verification.md#the-iphone-12-readings-of-2026-11-26-evening-182-build-100800209-five-iphone-entries-and-a-read-withheld-until-the-first-touch)):
in an app process with no touch yet, a DM opened by a banner tap (from a killed state, then from the
background, then a plain resume) was shown but never read: no `cancelConversationNotification` line,
its other banners stayed, and the sender's seat kept the "sent" receipt. The first touch anywhere in
the page released both. Cause: the receipt effect asked `document.hasFocus()`, which the iPhone's
WKWebView answers false until a touch. Fixed by `fix/ios-read-before-first-touch`: on native mobile
the shell's foreground alone says the app is in front (`windowReadVerdict`, `nativeMobile`), as the
arrival path already did (`arrivalContextNow`). Verified by unit tests only.

**The reading, on the iPhone 12, on the first alpha carrying it.** Kill the app, send two DMs from a
web seat (two banners), tap the second banner and touch nothing: within seconds the syslog reads
`cancelConversationNotification ... removed=1` (the untapped banner), Notification Center holds no
row of that DM, and the sender's seat reads the message as read. Then home, a third DM, tap its
banner, touch nothing: the same. Charter: principle 2 (the essential is never lost) - a read that
waits for a touch leaves banners and an unread count for what was seen.
