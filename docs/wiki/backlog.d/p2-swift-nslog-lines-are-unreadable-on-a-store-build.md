## P2 - the Swift `NSLog` lines outside the tab-bar plugin are unreadable on a store build

The tab-bar plugin's lines were moved to a public `Logger` once a store build was measured to redact
a Swift `NSLog` to `<private>` ([durable-rules](../durable-rules.md), [mobile](../frontend/mobile.md)).

**Measured for the extension (iPhone 12, `1.6.5-alpha.1` TestFlight, 2026-11-05):** a push read
with the app killed left every notification service extension line `<private>`, so the cause of a
generic DM banner could not be read. **The extension is moved** to `NseLog.log` with each value's
privacy named ([mobile](../frontend/mobile.md#the-extensions-copy-of-the-state-follows-every-write-2026-11-05)),
and `nativeLogContent.test.ts` refuses a Swift `NSLog` there. Owed: one push read in clear on the
first pre-release carrying it.

**Left:** the 5 lines of the keystore patch (`patches/tauri-plugin-keystore/ios`), then the gate: a
test refusing a Swift `NSLog` anywhere under `gen/apple` and `patches/*/ios`.
