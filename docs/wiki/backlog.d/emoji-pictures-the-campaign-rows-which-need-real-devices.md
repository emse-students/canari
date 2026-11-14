## Reading owed - the twelve emoji-picture rows on real devices, the iPhone first

target: 1.7.0

The pictures replaced the font on 2026-09-25 ([emoji](../frontend/emoji.md)). **Open:** the twelve rows of the second campaign, all needing real devices (the iPhone, where the font never drew, first) - they live in [emoji](../frontend/emoji.md#what-a-future-campaign-owes---the-twelve-rows-moved-from-the-backlog-2026-10-08).

**Read 2026-11-14 on the iPhone 12, TestFlight `1.6.12-alpha.2`, dev estate** ([readings](../device-verification.md#the-iphone-12-batch-6-readings-of-2026-11-14)): Rows 1-3, iPhone, visually `PASS`: one message carrying a smiley, a flag, a ZWJ family, a skin-toned person, an Emoji 16 face and an Emoji 16 fingerprint, and a heart sent WITHOUT U+FE0F, arrived drawn as pictures, the flag and the family each ONE picture. The DOM reads (`naturalWidth`), the picker rows (4-6, 11), the reaction round trip (8), the notification (9), the exports (10) and the composer (12) are not read.
