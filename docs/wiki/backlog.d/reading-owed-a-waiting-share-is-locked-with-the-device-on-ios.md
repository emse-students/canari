## Reading owed - a waiting share is locked with the device on iOS

target: 1.7.0

**What is built:** a waiting share is locked with the device on iOS (built 2026-10-27; the mechanism and the seven steps are in [sharing](../frontend/sharing.md), "At rest", iOS path item 5)

**The reading that closes it:** on the iPhone 12 with a passcode, waiting over 10 s after each lock, Console on `[CanariShare]` / `[SHARE]`: (1) cold launch, a `launch sweep:` line and no `deferred`; (2) a text and a photo, `moved copy protection = NSFileProtectionCompleteUnlessOpen`; (3) Canari killed, locked, a push: `locked with the device`, the share kept, no `dropped`/`unreadable` (a bare `NSCocoaErrorDomain 513` is a finding to record, not a regression); (4) unlock, offered at once; (5) already imported, offered with no new launch; (6) a large iCloud video locked mid-capture, the older share kept and the new one refused on the card; (7) sign-out while locked, the old share dropped as stale

**Read 2026-11-14 on the iPhone 12, TestFlight `1.6.12-alpha.2`, dev estate** ([readings](../device-verification.md#the-iphone-12-batch-6-readings-of-2026-11-14)): **Not read - the precondition is missing**: the bench iPhone has NO passcode (`ios.mjs unlock` after a lock raises no keypad), so `NSFileProtectionCompleteUnlessOpen` never takes effect and every step of the seven would read PASS vacuously. It needs a passcode set on the bench phone, a device setting outside the owner's 2026-11-14 grant (install, wipe, restart).
