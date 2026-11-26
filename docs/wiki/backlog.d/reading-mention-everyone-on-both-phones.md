## Reading owed - "@tous" reaches every member at "Mentions" and nobody at "Aucune", on both phones (2026-11-26)

target: 1.8.2

**Built and tested, never run on a device** ([chat-delivery](../services/chat-delivery.md#tous---a-call-to-every-member-and-who-may-make-it-decided-2026-11-26); owner decision of 2026-11-25; charter principle 3). The decision is asserted on all three platforms against `libs/contracts/mention-decision.cases.json` (vitest and the Android JVM tests run; **the iOS extension's change is verified by reading only - its contract test is still not wired to a target**), and the server's vouching by its jest tests. What is owed is the reading below on BOTH bench phones, on a build carrying this change.

**What to read, per phone** (the phone's account at "Mentions" in the conversation, the app backgrounded; the sender on another device):

1. **A group.** A plain member writes `@tous rdv 18h`: the phone rings with the mention sound (Android: the mentions channel; iOS: time-sensitive, mention trill). Then `@everyone`: the same. Then `merci a tous` (no `@`): nothing.
2. **A salon, sender is a moderator.** The composer offers the `@tous` row; the message rings the phone as a mention; the bubble draws `@tous` as a chip.
3. **A salon, sender is a plain member.** The composer does NOT offer the row; typed by hand, the message is sent and does NOT ring a phone at "Mentions"; the server log carries `[MENTION_EVERYONE] not vouched`.
4. **"Aucune".** Set the conversation (group, then salon) to "Aucune": a moderator's `@tous` rings nothing.

**What closes it**: items 1 to 4 pass on the Mi 9T AND the iPhone 12. A failure names the surface that did not obey (the composer offer, the server's vouching, `NotificationLevelGate`, the extension's `levelDecision`, the client's `everyoneMentionOf`).
