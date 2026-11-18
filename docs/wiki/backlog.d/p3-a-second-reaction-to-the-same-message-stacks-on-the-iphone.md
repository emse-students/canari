## P3 - a second reaction to the same message stacks on the iPhone, where Android replaces it

target: 1.7.1

**Seen 2026-11-18 (iPhone 12, `1.7.0-alpha.11`, dev, [readings](../device-verification.md#the-phone-readings-of-2026-11-18-m1-and-i1-170-alpha11)):** `beta` reacted ❤️ then 😂 to one message of `gamma`'s, with the iPhone locked and then with the app killed. Each time Notification Center held TWO entries, "a réagi ❤️ à votre message" and "a réagi 😂 à votre message". On the Mi 9T the second reaction replaces the first (one record keyed `reaction:<groupId>`).

**Why, from the code:** the iOS identity is `reactionCollapseId` = `stableNotifId(reaction:<messageId>:<reactor>:<at>)`, the reaction's own instant included ([mobile](../frontend/mobile.md)), so two reactions are two requests by design; the Android key is the conversation. The reading entry asked for a replacement on both platforms.

**To decide, then build:** one key per (message, reactor) on iOS (dropping `at` from the hash, which the content-free push review must re-check, since the id rides a header Apple reads), or accept the divergence and say so in the wiki. Not a regression since `v1.6.12`. Charter: principle 3 (your attention is not for sale).
