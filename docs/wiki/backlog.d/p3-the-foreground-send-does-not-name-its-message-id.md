## P3 - the foreground send does not name its messageId, so an adopted orphan can still be queued twice

target: 1.10.0

Since migration 048 the server stores one message per `(group, sender, device, messageId)` and
answers a repeat with the first copy's receive time
([chat-delivery](../services/chat-delivery.md#a-message-sent-twice-under-one-id-is-stored-once-migration-048-2026-11-13)).
The native senders have always named the id; the foreground `POST mls/send` does not
(`postApplicationMessage` in `mlsDeliveryApi.ts` posts no `messageId`, though `sendMessage` in
`BaseMlsService.ts` already receives it as `_messageId`). So a native send whose answer was lost,
then ADOPTED by the app at login (`adoptOrphanedMirrorEntries`) and sent by the foreground flusher,
is still queued a second time, and so is a foreground retry after a transport failure
(`DeliveryUnreachableError`).

**Why it was not done with the server half.** A server older than 048 refuses an unknown field on
that route (`send_field_refused`, `CLIENT_SEND_FIELDS`), and a store build reaches phones before the
stable deploys production. So the client half ships in a release AFTER the stable carrying 048 is
in production (or behind a capability the client reads first), never in the same one.

**An addressed frame must not be keyed like a broadcast one.** The foreground re-sends an ADDRESSED
frame (`recipientDevices`, a history answer) under one id to different addressees; the receipt is
keyed on `(group, sender, device, messageId)` alone, so the second addressee's copy would be answered
as a repeat and dropped. Before the foreground names ids, either the key includes the addressee set,
or an addressed frame does not name its id (the server then claims no receipt for it).

**A named send holds one database connection for its whole delivery, and that is not measured.**
`sendMessage` takes the message's advisory lock on a query runner of its own (`takeSentFrameLock`,
`utils/sent-frame-receipt.ts`) before the claim and releases it after the settlement, so the
connection is out of the pool for the enqueue, the live delivery and the push of that send - beside
the connection the enqueue transaction itself uses. Today only the native background senders name
an id, a trickle. The foreground is every message: a burst of N sends at once then asks the pool for
up to 2N connections, and a send that waits for one is a send that is late. Before the foreground
names ids, read on dev, under a burst sized from production's busiest minute: the pool's size
against the connections held at the peak, how long a send waits for one, and the p95 send time with
and without ids. If the pool is the bound, the lock moves off a held connection (or the pool grows,
measured) BEFORE the client change ships.

**The change, when that holds.** Thread the id from `sendMessage` through `emitFrame` to
`postApplicationMessage` and put it in the body when present; update the at-least-once comment in
`postApplicationMessage`, and its test (`mlsDeliveryApi.addressed.test.ts`).
