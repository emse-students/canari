## P3 - salon texts held by a `502` are posted in the order their backoffs end, not the order they were written

target: 1.7.3

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
