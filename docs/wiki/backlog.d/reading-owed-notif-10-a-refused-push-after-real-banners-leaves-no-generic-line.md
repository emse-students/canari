## Reading owed - NOTIF-10: a refused push after real banners leaves no generic line

target: 1.7.0

**What is built:** NOTIF-10: a refused push after real banners leaves no generic line (2026-10-09, `GenericBannerLedger` unclaimed notes; JVM-tested, the service's two cancel hooks NOT compiled from here)

**The reading that closes it:** `bun archive/notif.mjs 10` on the Mi 9T against a build carrying it: five messages with the push channel cut, then the radios back; the shade ends with the summary and the real banners, NO `Nouveau message de ...` ([mobile](../frontend/mobile.md), board row [NOTIF-10](../cross-client-testing-archive-1-4-0.md#14---notif---notifications))
