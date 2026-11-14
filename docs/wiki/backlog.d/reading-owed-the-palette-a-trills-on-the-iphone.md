## Reading owed - the palette-A trills on the iPhone

target: 1.7.0

**What is built:** the palette-A trills on the iPhone (#2000, `v1.3.0`; the three files are in the app's and the extension's Resources, and every App Store archive since has copied them), and the generic ring alert of an iPhone with no VoIP token rings Canari's own tone (`IOS_CALL_RING_SOUND`, backlog triage of 2026-11-11) ([sounds](../frontend/sounds.md))

**The reading that closes it:** on the iPhone 12, a TestFlight build: a DM, a mention and a reaction each heard as its trill; then, with no VoIP token, one incoming call whose banner rings the C1 tone, not the system's

**Read 2026-11-14 on the iPhone 12, TestFlight `1.6.12-alpha.2`, dev estate** ([readings](../device-verification.md#the-iphone-12-batch-6-readings-of-2026-11-14)): **Not read - it needs a human ear**: the syslog and the accessibility tree say a banner arrived, never which sound played. Pushes did arrive on the TestFlight build 6 of 6 (banner with text on the lock screen), so the owner only has to listen: a DM, a mention and a reaction, then a call ring with no VoIP token.
