## Reading owed - the iOS app no longer aborts when its accessibility tree is read

target: 1.7.0

**What is built:** the iOS app no longer aborts when its accessibility tree is read (#2101, `v1.3.0`; the WDA query PASSED on `1.3.1-alpha.1`, [device-readings](../device-readings-2026-10.md))

**The reading that closes it:** the two syslog lines on the iPhone 12: `[CanariPush] APNs token received` after `registerForRemoteNotifications`, and the becoming-active line naming `the kept-alive one`
