## P2 - the Swift log lines on a store build: built, two readings owed

A store build redacts a Swift `NSLog` to `<private>` whole, so every Swift line moved to a public
`Logger` with each value's privacy named: the extension (`NseLog`, `1.6.5-alpha.1`), then on
2026-11-06 the keystore patch, the system-components button, the custom-tabs and the gallery
plugins. `nativeLogContent.test.ts` refuses a Swift `NSLog` in any `.swift` file under `gen/apple`,
`patches` and `plugins` ([mobile](../frontend/mobile.md#the-extensions-copy-of-the-state-follows-every-write-2026-11-05)).

**Owed on the iPhone 12, on any build `>= 1.6.6-alpha.2`:** rows R1a (the extension) and R1b (a
plugin, at sign-in) of [device-verification](../device-verification.md#ios-3075-the-ios-follow-ups-of-3075---owed-on-the-iphone-12).
Closes when both are read.
