## P2 - the Swift log lines on a store build: built, two readings owed

A store build redacts a Swift `NSLog` to `<private>` whole, so every Swift line moved to a public
`Logger` with each value's privacy named: the extension (`NseLog`, `1.6.5-alpha.1`), then on
2026-11-06 the keystore patch, the system-components button, the custom-tabs and the gallery
plugins. `nativeLogContent.test.ts` refuses a Swift `NSLog` in any `.swift` file under `gen/apple`,
`patches` and `plugins` ([mobile](../frontend/mobile.md#the-extensions-copy-of-the-state-follows-every-write-2026-11-05)).

**Owed on the iPhone 12, on the first pre-release carrying it** (`pymobiledevice3 syslog live`):

1. One push read with the app killed: the `[CanariNSE]` lines in clear, `outcome=` included.
2. One sign-in: a `[KeystorePlugin]` or `[CustomTabsPlugin]` line in clear (subsystem
   `fr.emse.canari`), not `Canari{Foundation} <private>`.

Closes when both are read.
