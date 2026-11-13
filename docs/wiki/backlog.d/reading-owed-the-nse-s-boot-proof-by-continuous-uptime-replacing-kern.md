## Reading owed - the NSE's boot proof by continuous uptime, replacing `kern.bootsessionuuid`

target: 1.7.0

**What is built:** the NSE's boot proof by continuous uptime, replacing `kern.bootsessionuuid` (#3075, 2026-11-06; [mobile](../frontend/mobile.md#what-the-extension-did-in-the-apps-log-2026-11-01))

**The reading that closes it:** on the iPhone 12, any build `>= 1.6.6-alpha.2`: rows R3a (no sandbox refusal) and R3b (a marker from before a reboot) of [device-verification](../device-verification.md#ios-3075-the-ios-follow-ups-of-3075---owed-on-the-iphone-12); R3b decides whether the one-sided proof (a marker stamped ahead of the reader's uptime is another boot's) is enough
