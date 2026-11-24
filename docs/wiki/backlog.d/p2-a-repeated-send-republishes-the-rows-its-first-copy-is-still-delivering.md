## P2 - a repeated send republishes the queued rows its first copy is still delivering

target: 1.8.1

**Seen 2026-11-24** (a new web device, prod `1.7.3`): one Welcome row arrived live twice, 160 ms
apart, same queued id, same size - `[QUEUE] delivery ... arrived twice - THE SERVER PUBLISHED THE SAME
ROW TWICE`. The client deduplicated it (acknowledged, not decrypted again), so nothing was lost; the
line is right to accuse the server.

**The mechanism, read from the code** (`apps/chat-delivery-service/src/services/messaging.service.ts`).
The server publishes a queued row from exactly two places: the first send's delivery step
(`deliverQueuedRows` after the enqueue) and a REPEAT of the same `messageId` that finds its receipt
unsettled (`finishFirstCopy`, migration 048). The first send marks its receipt settled only AFTER its
delivery ran (`markSentFrameSettled`). So a repeat arriving while the first send is still delivering -
a sender whose first POST timed out on its side and was sent again - takes the settlement
(`takeSentFrameSettlement`) and delivers the still-queued rows a second time. "Unsettled" means both
"the first send may have crashed" and "the first send is still running", and the receipt cannot tell
them apart. To confirm on production, read-only: a `REPEAT_FINISHED_FIRST_COPY` line on chat-delivery
for that group around 12:45:43Z on 2026-11-24.

**The fix to build:** the receipt states which send is delivering, taken in the enqueue transaction and
released at the settle, so a repeat finishes only a delivery nobody is running - without a clock, which
rules out a lease.

**The test that closes it:** `messaging.send-race.spec.ts` - a repeat of the same `messageId` arriving
while the first send is parked between its enqueue and its settle publishes nothing, and the first
send's delivery publishes each row once.
