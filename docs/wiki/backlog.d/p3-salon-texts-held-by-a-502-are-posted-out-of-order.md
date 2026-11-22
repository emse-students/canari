## P3 - salon texts held by a `502` are posted in the order their backoffs end, not the order they were written

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

**Found by:** the iPhone salon half of the deploy drill, sitting S5 on `1.7.0-alpha.12`
([readings](../device-verification.md#the-phone-readings-of-2026-11-18-s5-170-alpha12-the-alpha12-fixes-on-both-phones)).
Dev's `social-service` was stopped 47 s while `gamma` wrote into a test salon from the iPhone 12. Four texts
were written in the order 2, 4, 7, 8 (`[SEND] handleSendChat` at 05:59:34, 05:59:50, 06:00:15, 06:00:22 local);
each was held (`channel send ... HELD: the server is not serving (status=502)`, then `sent again ... in 2000 /
5000 / 15000 / 30000 ms`). The service came back at 06:00:22; the texts were then accepted at 06:00:29, :30, :38
and :43 (`[SALON-ECHO] ... settled as`), in the order **2, 8, 7, 4**: every text written after the return, or
whose timer ran out first, went before the older ones still waiting on a 30 s backoff. The server rows
(`channel_messages.createdAt`) and the peer's web seat show the same order, so a reader of the salon sees the
conversation shuffled. Each text arrived exactly once, and no "Échec" or "Non confirmé" was drawn, so the drill's
own reading passed.

**Why it is not the drill's verdict:** the "not now" contract (R05) promises no failure and no duplicate; it says
nothing on order. **Not a regression on this evidence:** the held send in
`frontend/src/lib/utils/chat/messaging.ts` dates from R05 (`v1.6.10`); the only change since `v1.6.12` on that
file (#3792) is about reaction notifications.

**What a fix has to answer:** a held salon text owns a per-message timer, so the queue has no order. The send of
a salon text should wait behind any earlier text of the same salon that is still held (one ordered queue per
salon, drained in order on the first answer that is not "not now"), rather than each text racing its own backoff.
No timer is needed to fix it: the order is a fact the client already holds.

**The reading that closes it:** the same drill (dev `social-service` stopped about 45 s, the phone writing a text
every few seconds through the outage): the texts reach the peer in the order they were written.

**2026-11-22, [I1 sitting](../device-verification.md#the-iphone-12-readings-of-2026-11-22-173-alpha5-the-backup-domains-the-banners-the-reactions-the-replay-bar-the-outage-drill) (`1.7.3-alpha.5`, iPhone 12): REPRODUCED, the fix is not built.** Dev's `social-service` stopped 07:28:38 to 07:30:01; `gamma` wrote `T1` (before), `T2` to `T6` every 5 to 14 s during the outage, `T7` and `T8` just after the restart. The salon read, live and again after a terminate and relaunch (the server's order): **T1, T6, T7, T8, T2, T3, T4, T5**. Each text once, no "Echec" or "Non confirme". Evidence outside the repository.

**2026-11-22: the fix is built** - one ordered lane per salon (`salonSendLane.ts`, `deliverSalonSend`): only the first unsent text of a salon is on the wire, a text written behind a head held for the server asks the head again instead of POSTing itself, a turn asked that way is never counted toward the head's bound, polls and forwarded files join the lane, a past page life's texts keep the ledger's order, and the repeat proof that made an unsent text step aside is retired (review of #3964). The mechanism, what holds a place and what leaves it: [chat](../frontend/modules/chat.md#a-salon-is-received-in-the-order-it-was-written-one-lane-per-salon-2026-11-22). The drill is reproduced in `useMessaging.salonOrder.svelte.test.ts`, failing without the lane. **Owed: the reading above, on the next pre-release.**

**2026-11-22, Mi 9T (`1.7.3-alpha.6`): the drill PASSES on Android.** Dev's `social-service` stopped 81 s; the phone wrote `T1`
before, `T2` to `T6` every ~7 s during, `T7` and `T8` just after the restart. The salon read **T1, T2, T3, T4, T5, T6, T7, T8**,
each once, no "Echec" and no "Non confirme"; the server rows of T2..T8 landed in one 4 s burst after the restart (the lane
draining in order). A second outage: a text held ("En attente du serveur...") and a poll created behind it is REFUSED with
"Des messages de ce salon attendent encore d'etre envoyes : reessaie une fois qu'ils seront partis.", the draft kept open; the
held text left once after the restart. **The iPhone half, where it failed on `alpha.5`, is not read on this build: the entry stays.**
