## Reading owed - "@tous" reaches every member at "Mentions" and nobody at "Aucune", on both phones (2026-11-26)

target: 1.8.2

**Built and tested, never run on a device** ([chat-delivery](../services/chat-delivery.md#tous---a-call-to-every-member-and-who-may-make-it-decided-2026-11-26); owner decision of 2026-11-25; charter principle 3). The decision is asserted on all three platforms against `libs/contracts/mention-decision.cases.json` (vitest and the Android JVM tests run; **the iOS extension's change is verified by reading only - its contract test is still not wired to a target**), and the server's vouching by its jest tests. What is owed is the reading below on BOTH bench phones, on a build carrying this change.

**What to read, per phone** (the phone's account at "Mentions" in the conversation, the app backgrounded; the sender on another device):

1. **A group.** A plain member PICKS the `@tous` row and sends `@tous rdv 18h`: the phone rings with the mention sound (Android: the mentions channel; iOS: time-sensitive, mention trill), and the banner reads "@tous" (never `@[everyone]`). Then `merci @tous` TYPED by hand, not picked: nothing, as for a name typed by hand.
2. **A salon, sender is a moderator.** The composer offers the `@tous` row; the message rings the phone as a mention; the bubble draws `@tous` as a chip.
3. **A salon, sender is a plain member.** The composer does NOT offer the row; typed by hand, the word is text and rings nobody.
4. **"Aucune".** Set the conversation (group, then salon) to "Aucune": a moderator's `@tous` rings nothing.

**What closes it**: items 1 to 4 pass on the Mi 9T AND the iPhone 12. A failure names the surface that did not obey (the composer offer, the server's vouching, `NotificationLevelGate`, the extension's `levelDecision`, the client's `everyoneMentionOf`).

**Read on the Mi 9T, 1.8.2-alpha.7 (2026-11-26):** item 1 PASSES (a group: the picked `@tous` rang the phone with the mention sound, the banner read "@tous"; typed by hand it rang nothing). Items 2 to 4 (salon cases, "Aucune") and the whole iPhone 12 half are still owed.

**Read on the iPhone 12, `1.8.2-alpha.7` ([sitting](../device-verification.md#the-readings-of-2026-11-26-182-alpha7-iphone-12-tous-the-read-tone-the-seat-hold-a-group-from-respondents-a-dms-open)): item 1 PASSES.** The group, the phone at "Mentions" and backgrounded: the picked `@tous` raised a time-sensitive "Mentioned you" row; the same word typed by hand and a plain message left the passive row. **A deviation to decide:** the banner and the chip read `@everyone`, not `@tous`. Left on the iPhone: items 2 to 4 (the salon, "Aucune").

**Read on the Mi 9T, `1.8.2-alpha.8` (2026-11-26, [sitting](../device-verification.md#the-readings-of-2026-11-26-182-alpha8-mi-9t-the-v22-store-upgraded-a-picked-file-sent-the-person-filter-tous-in-a-salon)): the composer half of items 2 and 3 PASSES.** In a salon of a community the account administers, `@to` offers the `@tous` row; in a salon of a community it only belongs to, no row. Nothing was sent: the ring of a salon `@tous` (item 2) and "Aucune" (item 4) are still owed on both phones.

**Read on the iPhone 12, `1.8.2-alpha.8`, in French ([sitting](../device-verification.md#the-readings-of-2026-11-26-182-alpha8-iphone-12-the-first-open-of-the-store-fix-tous-in-french-a-picked-photo-and-file)): the wording deviation is settled for the composer and the own bubble.** With Canari's own language on Francais (the phone's OS language untouched), the picker row reads `@tous - Notifie tous les membres`, the composer chip `@tous`, the sent bubble `@tous <text>`. `@everyone` is therefore the ENGLISH label only, as the entry expects. Still not read on the iPhone: the notification banner of a received picked mention in French, and the salon cases and "Aucune" (items 2 to 4). **Seen on the way, to decide:** after the language switch's reload the log carried seven `[TAURI] Couldn't find callback id ...` warnings over ninety seconds (a Rust async operation outliving the reload keeps answering a page that is gone); a reload is an explicit user action, but the line is the visible end of something upstream and the noise rule applies.
