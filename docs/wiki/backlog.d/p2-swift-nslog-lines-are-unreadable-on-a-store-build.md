## P2 - the Swift `NSLog` lines outside the tab-bar plugin are unreadable on a store build

The tab-bar plugin's lines were moved to a public `Logger` once a store build was measured to redact
a Swift `NSLog` to `<private>` ([durable-rules](../durable-rules.md), [mobile](../frontend/mobile.md)).
Two other places still use Swift `NSLog`: about 88 lines in the notification service extension
(`frontend/src-tauri/gen/apple/canari_NSE/NotificationService.swift`, among them the `[PUSH_WAKE]`,
`outcome:` and `[NOTIF]` lines that push readings depend on) and 5 in the keystore patch
(`patches/tauri-plugin-keystore/ios`).

**Not measured yet:** the extension runs in its own process, and no wiki page records one of its
lines read in clear or as `<private>` on a TestFlight build. First, read one push on a TestFlight
build to settle that. If the lines are redacted, move each one to a `Logger`, choosing public or
private value by value. Several of those lines interpolate a group-id prefix, a type and a content
key, so the plugin's all-`.public` pattern is not copied blindly. The gate is a test that refuses a
Swift `NSLog` anywhere under `gen/apple` and `patches/*/ios`, as `scrollToTop.test.ts` does for the
plugin's two files.
